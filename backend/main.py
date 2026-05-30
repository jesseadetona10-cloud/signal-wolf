from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Float, Boolean, Index
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime, timedelta
import requests
import logging
import time
import threading
import json
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from collections import deque
import os
import uuid
from dotenv import load_dotenv
from sklearn.model_selection import train_test_split
from typing import List, Dict, Tuple, Optional

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────────────────────────────────────

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")
TWELVE_DATA_API_KEY = os.getenv("TWELVE_DATA_API_KEY", "4d2e88baa526473b904952db67c46d02")
IQ_EMAIL = os.getenv("IQ_EMAIL", "")
IQ_PASSWORD = os.getenv("IQ_PASSWORD", "")
REQUEST_TIMEOUT = 15

# V8 Core Settings
SEQUENCE_LENGTH = 10
INPUT_SIZE = 12
EDGE_THRESHOLD = 0.65
ML_MIN_SEQUENCES = 50
KELLY_FRACTION = 0.5
MAX_CONCURRENT_TRADES = 2
SESSION_MAX_LOSS = -50
SESSION_TARGET = 100
TRAIN_INTERVAL_SECONDS = 600
VALIDATION_SPLIT = 0.2
EARLY_STOPPING_PATIENCE = 3
MODEL_DIR = "models"
ANOMALY_SPIKE_MULTIPLIER = 5

os.makedirs(MODEL_DIR, exist_ok=True)

# ──────────────────────────────────────────────────────────────────────────────
# DATABASE
# ──────────────────────────────────────────────────────────────────────────────

DATABASE_URL = "sqlite:///./signal_wolf.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Trade(Base):
    __tablename__ = "trades"
    id = Column(Integer, primary_key=True, index=True)
    trade_uuid = Column(String, unique=True, index=True)
    pair = Column(String, index=True)
    direction = Column(String)
    expiry = Column(String)
    confidence = Column(Integer)
    votes = Column(Integer)
    result = Column(String, index=True)
    indicators = Column(Text)
    sequence = Column(Text)
    entry_price = Column(Float)
    amount = Column(Float, default=0)
    outcome_label = Column(Integer, default=None)
    signal_time = Column(DateTime, default=datetime.utcnow)
    expiry_time = Column(DateTime)
    timestamp = Column(DateTime, default=datetime.utcnow)

class SequenceData(Base):
    __tablename__ = "sequence_data"
    id = Column(Integer, primary_key=True)
    trade_uuid = Column(String, index=True)
    pair = Column(String, index=True)
    sequence = Column(Text)
    label = Column(Integer, index=True)
    quality_score = Column(Float, default=1.0)
    timestamp = Column(DateTime, default=datetime.utcnow)

class ModelVersion(Base):
    __tablename__ = "model_versions"
    id = Column(Integer, primary_key=True)
    version = Column(String, unique=True, index=True)
    path = Column(String)
    val_accuracy = Column(Float)
    is_active = Column(Boolean, default=False)
    train_date = Column(DateTime, default=datetime.utcnow)

class PairState(Base):
    __tablename__ = "pair_state"
    id = Column(Integer, primary_key=True)
    pair = Column(String, unique=True, index=True)
    feature_history = Column(Text)
    last_updated = Column(DateTime, default=datetime.utcnow)

Base.metadata.create_all(bind=engine)

# ──────────────────────────────────────────────────────────────────────────────
# SESSION STATE
# ──────────────────────────────────────────────────────────────────────────────

class SessionState:
    def __init__(self):
        self.profit = 0
        self.loss = 0
        self.active_trades = []
        self.trade_history = []
        self.session_id = str(uuid.uuid4())[:8]
    
    def can_trade(self) -> Tuple[bool, str]:
        if len(self.active_trades) >= MAX_CONCURRENT_TRADES:
            return False, f"Max {MAX_CONCURRENT_TRADES} concurrent trades"
        if self.loss <= SESSION_MAX_LOSS:
            return False, f"Loss limit reached (${abs(self.loss):.2f})"
        if self.profit >= SESSION_TARGET:
            return False, f"Target reached (${self.profit:.2f})"
        return True, "OK"
    
    def add_trade(self, trade: dict):
        self.active_trades.append(trade)
    
    def close_trade(self, trade_uuid: str, result: str, pnl: float):
        for trade in self.active_trades:
            if trade.get("trade_uuid") == trade_uuid:
                trade["result"] = result
                trade["pnl"] = pnl
                self.trade_history.append(trade)
                self.active_trades.remove(trade)
                if result == "WIN":
                    self.profit += pnl
                else:
                    self.loss += pnl
                break
    
    def reset(self):
        self.profit = 0
        self.loss = 0
        self.active_trades = []
        self.session_id = str(uuid.uuid4())[:8]
    
    def get_summary(self) -> dict:
        return {
            "session_id": self.session_id,
            "profit": self.profit,
            "loss": self.loss,
            "net": self.profit + self.loss,
            "active_trades": len(self.active_trades),
            "total_trades": len(self.trade_history),
            "can_trade": self.can_trade()[0]
        }

session_state = SessionState()

# ──────────────────────────────────────────────────────────────────────────────
# LSTM MODEL
# ──────────────────────────────────────────────────────────────────────────────

class SignalWolfLSTM(nn.Module):
    def __init__(self, input_size, hidden_size=64, num_layers=2, output_size=3):
        super(SignalWolfLSTM, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=0.2)
        self.dropout = nn.Dropout(0.3)
        self.fc = nn.Sequential(
            nn.Linear(hidden_size, 32),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(32, output_size)
        )
    
    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        last_out = lstm_out[:, -1, :]
        return self.fc(self.dropout(last_out))

class TradeFilter(nn.Module):
    def __init__(self, input_size, hidden_size=32):
        super(TradeFilter, self).__init__()
        self.fc = nn.Sequential(
            nn.Linear(input_size * SEQUENCE_LENGTH, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, 2)
        )
    
    def forward(self, x):
        x = x.view(x.size(0), -1)
        return self.fc(x)

model = None
filter_model = None
ml_enabled = False

# ──────────────────────────────────────────────────────────────────────────────
# FASTAPI APP
# ──────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Signal Wolf", version="8.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:3000"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# PRICE FETCHING
# ──────────────────────────────────────────────────────────────────────────────

def fetch_yahoo_prices(pair: str, count: int = 100):
    try:
        symbol = pair.replace("/", "") + "=X"
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&range=1d"
        headers = {"User-Agent": "Mozilla/5.0"}
        response = requests.get(url, headers=headers, timeout=10)
        data = response.json()
        closes = data["chart"]["result"][0]["indicators"]["quote"][0]["close"]
        prices = [float(p) for p in closes if p is not None]
        if len(prices) >= 30:
            return prices[-count:]
        return None
    except Exception as e:
        logger.error(f"Yahoo error: {e}")
        return None

def fetch_twelve_data_prices(pair: str, count: int = 100):
    try:
        url = f"https://api.twelvedata.com/time_series?symbol={pair}&interval=1min&outputsize={count}&apikey={TWELVE_DATA_API_KEY}"
        response = requests.get(url, timeout=REQUEST_TIMEOUT)
        data = response.json()
        if "values" in data and data["values"]:
            return [float(c["close"]) for c in reversed(data["values"])]
        return None
    except Exception as e:
        logger.error(f"Twelve Data error: {e}")
        return None

def get_prices(pair: str, count: int = 100):
    prices = fetch_yahoo_prices(pair, count)
    if prices:
        return prices
    prices = fetch_twelve_data_prices(pair, count)
    if prices:
        return prices
    return []

# ──────────────────────────────────────────────────────────────────────────────
# FEATURE ENGINEERING
# ──────────────────────────────────────────────────────────────────────────────

def get_indicator_value(indicators, name):
    for ind in indicators:
        if ind.get("name") == name:
            try:
                return float(ind.get("value", 0))
            except:
                return 0
    return 0

def extract_features(indicators, prices):
    features = []
    features.append(get_indicator_value(indicators, "RSI") / 100)
    features.append(get_indicator_value(indicators, "STOCH") / 100)
    features.append(min(max(get_indicator_value(indicators, "BB"), 0), 1))
    features.append(get_indicator_value(indicators, "MACD") / 10)
    features.append(get_indicator_value(indicators, "CCI") / 200)
    
    call_count = sum(1 for i in indicators if i.get("vote") == "CALL")
    put_count = sum(1 for i in indicators if i.get("vote") == "PUT")
    total = len(indicators) if indicators else 1
    features.append(call_count / total)
    features.append(put_count / total)
    
    if prices and len(prices) > 20:
        recent = prices[-20:]
        features.append((recent[-1] - recent[0]) / (max(recent) - min(recent) + 1e-6))
        features.append(np.std(recent))
        features.append((recent[-1] - recent[-5]) / (recent[-5] + 1e-6))
        features.append((recent[-1] - min(recent)) / (max(recent) - min(recent) + 1e-6))
    else:
        features.extend([0, 0, 0, 0])
    
    hour = datetime.utcnow().hour
    features.append(hour / 24)
    features.append(1 if 7 <= hour <= 11 else 0)
    features.append(1 if 13 <= hour <= 17 else 0)
    
    return features

def build_sequence(feature_history, current_features):
    if len(feature_history) < SEQUENCE_LENGTH - 1:
        return None
    history = list(feature_history).copy()
    history.append(current_features)
    return np.array(history[-SEQUENCE_LENGTH:])

# ──────────────────────────────────────────────────────────────────────────────
# ANOMALY DETECTION
# ──────────────────────────────────────────────────────────────────────────────

def detect_anomaly(prices):
    if len(prices) < 20:
        return False
    moves = np.diff(prices[-10:])
    if len(moves) == 0:
        return False
    spike = max(abs(moves))
    if spike > np.std(moves) * ANOMALY_SPIKE_MULTIPLIER:
        return True
    return False

# ──────────────────────────────────────────────────────────────────────────────
# KELLY POSITION SIZING
# ──────────────────────────────────────────────────────────────────────────────

def kelly_fraction(win_prob: float, payout: float = 0.8) -> float:
    if win_prob <= 0 or win_prob >= 1:
        return 0
    b = payout
    p = win_prob
    q = 1 - p
    kelly = (b * p - q) / b
    return max(0, min(kelly, 0.25))

def get_trade_amount(balance: float, win_prob: float) -> float:
    kelly = kelly_fraction(win_prob)
    safe_kelly = kelly * KELLY_FRACTION
    amount = balance * safe_kelly
    return max(1, min(amount, balance * 0.1))

# ──────────────────────────────────────────────────────────────────────────────
# MODEL TRAINING
# ──────────────────────────────────────────────────────────────────────────────

def get_labeled_sequence_count():
    db = SessionLocal()
    count = db.query(SequenceData).count()
    db.close()
    return count

def train_models():
    global model, filter_model, ml_enabled
    
    db = SessionLocal()
    sequences = db.query(SequenceData).filter(SequenceData.quality_score >= 0.5).order_by(SequenceData.timestamp.desc()).limit(2000).all()
    sequence_count = len(sequences)
    db.close()
    
    if sequence_count >= ML_MIN_SEQUENCES and not ml_enabled:
        ml_enabled = True
        logger.info(f"ML AUTO-ENABLED: {sequence_count} labeled sequences available")
        send_telegram(f"ML AUTO-ENABLED\n{sequence_count} labeled sequences\nEdge threshold: {EDGE_THRESHOLD}")
    
    if sequence_count < ML_MIN_SEQUENCES:
        logger.info(f"ML disabled: need {ML_MIN_SEQUENCES} sequences, have {sequence_count}")
        return None, None
    
    X, y = [], []
    class_counts = [0, 0, 0]
    
    for seq_data in sequences:
        try:
            seq = np.array(json.loads(seq_data.sequence))
            X.append(seq)
            y.append(seq_data.label)
            class_counts[seq_data.label] += 1
        except:
            continue
    
    if len(X) < ML_MIN_SEQUENCES:
        return None, None
    
    X = np.array(X)
    y = np.array(y)
    
    try:
        X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=VALIDATION_SPLIT, stratify=y, random_state=42)
    except:
        X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=VALIDATION_SPLIT, random_state=42)
    
    total = len(y_train)
    class_weights = [total / (3 * max(c, 1)) for c in class_counts]
    cw_tensor = torch.tensor(class_weights, dtype=torch.float32)
    
    new_model = SignalWolfLSTM(INPUT_SIZE)
    optimizer = optim.Adam(new_model.parameters(), lr=0.001)
    criterion = nn.CrossEntropyLoss(weight=cw_tensor)
    
    best_val_loss = float("inf")
    patience_counter = 0
    
    for epoch in range(50):
        new_model.train()
        train_loss = 0
        for i in range(0, len(X_train), 32):
            bx = torch.tensor(X_train[i:i+32], dtype=torch.float32)
            by = torch.tensor(y_train[i:i+32], dtype=torch.long)
            optimizer.zero_grad()
            out = new_model(bx)
            loss = criterion(out, by)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()
        
        new_model.eval()
        val_loss = 0
        correct = 0
        with torch.no_grad():
            for i in range(0, len(X_val), 32):
                bx = torch.tensor(X_val[i:i+32], dtype=torch.float32)
                by = torch.tensor(y_val[i:i+32], dtype=torch.long)
                out = new_model(bx)
                loss = criterion(out, by)
                val_loss += loss.item()
                preds = torch.argmax(out, dim=1)
                correct += (preds == by).sum().item()
        
        val_acc = correct / len(y_val) if len(y_val) > 0 else 0
        
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
        else:
            patience_counter += 1
        
        if patience_counter >= EARLY_STOPPING_PATIENCE:
            break
    
    y_filter = np.array([0 if label in (0, 1) else 1 for label in y])
    try:
        Xf_train, Xf_val, yf_train, yf_val = train_test_split(X, y_filter, test_size=VALIDATION_SPLIT, random_state=42)
    except:
        Xf_train, Xf_val, yf_train, yf_val = X, X, y_filter, y_filter
    
    new_filter = TradeFilter(INPUT_SIZE)
    opt_f = optim.Adam(new_filter.parameters(), lr=0.001)
    crit_f = nn.CrossEntropyLoss()
    
    for epoch in range(30):
        new_filter.train()
        for i in range(0, len(Xf_train), 32):
            bx = torch.tensor(Xf_train[i:i+32], dtype=torch.float32)
            by = torch.tensor(yf_train[i:i+32], dtype=torch.long)
            opt_f.zero_grad()
            out = new_filter(bx)
            loss = crit_f(out, by)
            loss.backward()
            opt_f.step()
    
    version = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    model_path = os.path.join(MODEL_DIR, f"model_v8_{version}.pth")
    filter_path = os.path.join(MODEL_DIR, f"filter_v8_{version}.pth")
    
    torch.save(new_model.state_dict(), model_path)
    torch.save(new_filter.state_dict(), filter_path)
    
    db = SessionLocal()
    mv = ModelVersion(version=version, path=model_path, val_accuracy=val_acc, is_active=True)
    db.add(mv)
    db.query(ModelVersion).filter(ModelVersion.id != mv.id).update({"is_active": False})
    db.commit()
    db.close()
    
    logger.info(f"Model trained! Val accuracy: {val_acc:.3f}, Sequences: {sequence_count}")
    return new_model, new_filter

def load_latest_model():
    global model, filter_model, ml_enabled
    db = SessionLocal()
    mv = db.query(ModelVersion).filter(ModelVersion.is_active == True).order_by(ModelVersion.train_date.desc()).first()
    sequence_count = db.query(SequenceData).count()
    db.close()
    
    if sequence_count >= ML_MIN_SEQUENCES:
        ml_enabled = True
        logger.info(f"ML enabled: {sequence_count} sequences available")
    
    if mv and os.path.exists(mv.path):
        try:
            model = SignalWolfLSTM(INPUT_SIZE)
            model.load_state_dict(torch.load(mv.path, map_location="cpu"))
            model.eval()
            
            filter_path = mv.path.replace("model", "filter")
            if os.path.exists(filter_path):
                filter_model = TradeFilter(INPUT_SIZE)
                filter_model.load_state_dict(torch.load(filter_path, map_location="cpu"))
                filter_model.eval()
            
            logger.info(f"Loaded model {mv.version}")
            return True
        except Exception as e:
            logger.error(f"Model load error: {e}")
    return False

def predict(sequence):
    global model, filter_model, ml_enabled
    if not ml_enabled or model is None or sequence is None:
        return None
    
    model.eval()
    with torch.no_grad():
        x = torch.tensor(sequence, dtype=torch.float32).unsqueeze(0)
        logits = model(x)
        probs = torch.softmax(logits, dim=1).numpy()[0]
    
    filter_pass = True
    if filter_model is not None:
        filter_model.eval()
        with torch.no_grad():
            fx = torch.tensor(sequence, dtype=torch.float32).unsqueeze(0)
            f_logits = filter_model(fx)
            f_probs = torch.softmax(f_logits, dim=1).numpy()[0]
            filter_pass = f_probs[0] > 0.5
    
    return {"CALL": float(probs[0]), "PUT": float(probs[1]), "SKIP": float(probs[2]), "filter_pass": filter_pass}

def pick_trade(prediction):
    if prediction is None or not prediction.get("filter_pass"):
        return None
    trade = max([("CALL", prediction["CALL"]), ("PUT", prediction["PUT"])], key=lambda x: x[1])
    if trade[1] < EDGE_THRESHOLD:
        return None
    return trade[0]

# ──────────────────────────────────────────────────────────────────────────────
# TELEGRAM
# ──────────────────────────────────────────────────────────────────────────────

def send_telegram(message: str):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "Markdown"}
        response = requests.post(url, json=payload, timeout=10)
        return response.json().get("ok", False)
    except Exception as e:
        logger.error(f"Telegram error: {e}")
        return False

# ──────────────────────────────────────────────────────────────────────────────
# IQ OPTION
# ──────────────────────────────────────────────────────────────────────────────

iq = None
iq_connected = False

def connect_iq():
    global iq, iq_connected
    try:
        import sys
        if sys.version_info >= (3, 12):
            logger.warning("IQ Option not compatible with Python 3.12+. Use venv311 (Python 3.11)")
            iq_connected = False
            return
        
        from iqoptionapi.stable_api import IQ_Option
        iq = IQ_Option(IQ_EMAIL, IQ_PASSWORD)
        check, reason = iq.connect()
        if check:
            iq.change_balance("PRACTICE")
            iq_connected = True
            logger.info("IQ Option connected")
            send_telegram("IQ Option connected (DEMO mode)")
        else:
            logger.warning(f"IQ Option connection failed: {reason}")
            iq_connected = False
    except ImportError:
        logger.warning("IQ Option library not installed. Run: pip install iqoptionapi")
        iq_connected = False
    except Exception as e:
        logger.error(f"IQ Option error: {e}")
        iq_connected = False

threading.Thread(target=connect_iq, daemon=True).start()

# ──────────────────────────────────────────────────────────────────────────────
# NEWS SHIELD
# ──────────────────────────────────────────────────────────────────────────────

news_cache = {"events": [], "last_updated": 0}

def fetch_news_events():
    if not FINNHUB_API_KEY:
        return []
    try:
        now = time.time()
        if now - news_cache["last_updated"] < 300:
            return news_cache["events"]
        
        today = datetime.utcnow().strftime("%Y-%m-%d")
        url = f"https://finnhub.io/api/v1/calendar/economic?from={today}&to={today}&token={FINNHUB_API_KEY}"
        response = requests.get(url, timeout=10)
        data = response.json()
        events = data.get("economicCalendar", [])
        
        high_impact = []
        for event in events:
            if event.get("impact") == "high":
                high_impact.append({"time": event.get("time", ""), "event": event.get("event", "")})
        
        news_cache["events"] = high_impact
        news_cache["last_updated"] = now
        return high_impact
    except Exception as e:
        return []

def is_news_safe():
    events = fetch_news_events()
    now = datetime.utcnow()
    for event in events:
        try:
            event_time = datetime.strptime(event["time"], "%Y-%m-%dT%H:%M:%S")
            if abs((now - event_time).total_seconds() / 60) <= 15:
                return False, event["event"]
        except:
            continue
    return True, None

# ──────────────────────────────────────────────────────────────────────────────
# FEATURE HISTORY PERSISTENCE
# ──────────────────────────────────────────────────────────────────────────────

def load_pair_state(pair: str):
    db = SessionLocal()
    state = db.query(PairState).filter(PairState.pair == pair).first()
    db.close()
    if state and state.feature_history:
        try:
            history = json.loads(state.feature_history)
            return deque(history, maxlen=SEQUENCE_LENGTH)
        except:
            return deque(maxlen=SEQUENCE_LENGTH)
    return deque(maxlen=SEQUENCE_LENGTH)

def save_pair_state(pair: str, history: deque):
    db = SessionLocal()
    state = db.query(PairState).filter(PairState.pair == pair).first()
    if state:
        state.feature_history = json.dumps(list(history))
        state.last_updated = datetime.utcnow()
    else:
        state = PairState(pair=pair, feature_history=json.dumps(list(history)))
        db.add(state)
    db.commit()
    db.close()

# ──────────────────────────────────────────────────────────────────────────────
# BACKGROUND TRAINING LOOP
# ──────────────────────────────────────────────────────────────────────────────

def training_loop():
    global model, filter_model, ml_enabled
    while True:
        time.sleep(TRAIN_INTERVAL_SECONDS)
        try:
            new_model, new_filter = train_models()
            if new_model:
                model = new_model
                filter_model = new_filter
                logger.info("Models updated")
        except Exception as e:
            logger.error(f"Training error: {e}")

# ──────────────────────────────────────────────────────────────────────────────
# API ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    db = SessionLocal()
    labeled = db.query(SequenceData).count()
    mv = db.query(ModelVersion).filter(ModelVersion.is_active == True).first()
    db.close()
    return {
        "status": "ok",
        "version": "8.1.0",
        "iq_connected": iq_connected,
        "model_ready": model is not None,
        "ml_enabled": ml_enabled,
        "labeled_sequences": labeled,
        "min_required": ML_MIN_SEQUENCES,
        "active_model": mv.version if mv else None,
        "session": session_state.get_summary()
    }

@app.get("/session")
def get_session():
    return session_state.get_summary()

@app.post("/session/reset")
def reset_session():
    session_state.reset()
    return {"status": "ok", "session": session_state.get_summary()}

@app.get("/iq/status")
def iq_status():
    return {"status": "ok", "connected": iq_connected}

@app.get("/iq/balance")
def iq_balance():
    try:
        if not iq_connected or not iq:
            return {"status": "error", "message": "Not connected"}
        balance = iq.get_balance()
        return {"status": "ok", "balance": balance}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/news")
def get_news():
    safe, event = is_news_safe()
    return {"status": "ok", "safe": safe, "blocking_event": event}

@app.post("/alert")
def send_alert(data: dict):
    db = SessionLocal()
    try:
        alert_type = data.get("type", "SIGNAL")
        
        if alert_type == "SESSION_START":
            session_state.reset()
            send_telegram(
                f"SESSION STARTED\n"
                f"Amount: ${data.get('amount', 0)}\n"
                f"Target: ${data.get('target', 0)}\n"
                f"ML: {'ACTIVE' if ml_enabled else 'COLLECTING DATA'}"
            )
            return {"status": "ok"}
        
        if alert_type == "KILL_SWITCH":
            send_telegram("KILL SWITCH - Session stopped")
            return {"status": "ok"}
        
        if alert_type == "TARGET_HIT":
            send_telegram(f"TARGET HIT! ${data.get('profit', 0):.2f}")
            return {"status": "ok"}
        
        if alert_type == "TRADE_RESULT":
            trade_uuid = data.get("trade_uuid")
            result = data.get("result")
            pnl = data.get("pnl", 0)
            
            session_state.close_trade(trade_uuid, result, pnl)
            
            emoji = "WIN" if result == "WIN" else "LOSS"
            send_telegram(
                f"{emoji} — {data.get('pair')}\n"
                f"P&L: ${pnl:.2f}\n"
                f"Session: ${session_state.profit + session_state.loss:.2f}"
            )
            
            trade = db.query(Trade).filter(Trade.trade_uuid == trade_uuid).first()
            if trade and trade.sequence:
                label = 0 if (result == "WIN" and trade.direction == "CALL") else 1 if (result == "WIN" and trade.direction == "PUT") else 2
                seq_data = SequenceData(
                    trade_uuid=trade_uuid,
                    pair=trade.pair,
                    sequence=trade.sequence,
                    label=label,
                    timestamp=datetime.utcnow()
                )
                db.add(seq_data)
                db.commit()
                
                new_count = db.query(SequenceData).count()
                if new_count >= ML_MIN_SEQUENCES and not ml_enabled:
                    threading.Thread(target=train_models, daemon=True).start()
            
            return {"status": "ok"}
        
        if alert_type == "GO_NOW":
            trade_uuid = data.get("trade_uuid")
            direction = data.get("direction")
            pair = data.get("pair")
            dir_emoji = "CALL" if direction == "CALL" else "PUT"
            send_telegram(
                f"GO NOW!\n"
                f"{dir_emoji} — {pair}\n"
                f"ID: {trade_uuid}"
            )
            return {"status": "ok"}
        
        # SIGNAL PROCESSING
        safe, event = is_news_safe()
        if not safe:
            return {"status": "blocked", "message": f"News: {event}"}
        
        pair = data.get("pair", "")
        direction = data.get("direction", "")
        expiry = data.get("expiry", "5M")
        indicators = data.get("indicators", [])
        auto_trade = data.get("auto_trade", False)
        amount_cfg = data.get("amount", 1)
        prices = get_prices(pair)
        
        if detect_anomaly(prices):
            logger.warning(f"Anomaly detected for {pair}")
            return {"status": "blocked", "message": "Market anomaly detected"}
        
        can_trade, reason = session_state.can_trade()
        if not can_trade:
            return {"status": "blocked", "message": reason}
        
        current_features = extract_features(indicators, prices)
        history = load_pair_state(pair)
        sequence = build_sequence(history, current_features)
        history.append(current_features)
        save_pair_state(pair, history)
        
        prediction = predict(sequence) if sequence is not None else None
        ml_direction = pick_trade(prediction) if prediction else None
        
        final_direction = direction
        final_confidence = data.get("confidence", 60)
        
        if ml_direction is None:
            if model is None or not ml_enabled:
                final_direction = direction
                final_confidence = data.get("confidence", 60)
                logger.info(f"ML not ready — using signal engine: {direction} {pair} ({final_confidence}%)")
            else:
                logger.info(f"ML rejected signal: {direction} {pair}")
                return {"status": "blocked", "message": f"ML: No edge ({direction} {pair})"}
        else:
            if ml_direction != direction:
                final_direction = ml_direction
                logger.info(f"ML override: {direction} → {ml_direction} for {pair}")
            
            final_confidence = int(prediction[ml_direction] * 100)
            if final_confidence < EDGE_THRESHOLD * 100:
                logger.info(f"ML low confidence: {final_confidence}% < {EDGE_THRESHOLD*100}%")
                return {"status": "blocked", "message": f"Low confidence: {final_confidence}%"}
        
        balance = iq.get_balance() if iq_connected and iq else 10000
        trade_amount = get_trade_amount(balance, final_confidence / 100)
        
        expiry_mins = int(expiry.replace("M", ""))
        trade_uuid = str(uuid.uuid4())[:8]
        entry_price = prices[-1] if prices else None
        
        trade_record = Trade(
            trade_uuid=trade_uuid,
            pair=pair,
            direction=final_direction,
            expiry=expiry,
            confidence=final_confidence,
            votes=data.get("votes", 0),
            indicators=json.dumps(indicators),
            sequence=json.dumps(sequence.tolist()) if sequence is not None else None,
            entry_price=entry_price,
            amount=trade_amount,
            signal_time=datetime.utcnow(),
            expiry_time=datetime.utcnow() + timedelta(minutes=expiry_mins),
            timestamp=datetime.utcnow()
        )
        db.add(trade_record)
        db.commit()
        
        session_state.add_trade({
            "trade_uuid": trade_uuid,
            "pair": pair,
            "direction": final_direction,
            "amount": trade_amount,
            "confidence": final_confidence,
            "expiry": expiry,
            "opened_at": datetime.utcnow().isoformat()
        })
        
        dir_emoji = "CALL" if final_direction == "CALL" else "PUT"
        entry_time = datetime.utcnow() + timedelta(seconds=45)
        wat_entry = entry_time + timedelta(hours=1)
        wat_entry_str = wat_entry.strftime("%H:%M WAT")
        wat_now = (datetime.utcnow() + timedelta(hours=1)).strftime("%H:%M:%S WAT")
        
        send_telegram(
            f"⚠️ *PREPARE TRADE*\n"
            f"━━━━━━━━━━━━━\n"
            f"{'🟢⬆️' if final_direction == 'CALL' else '🔴⬇️'} *{final_direction}* — *{pair}*\n"
            f"⏰ *Enter at: {wat_entry_str}*\n"
            f"⌛ Expiry: *{expiry}*\n"
            f"📊 Edge: *{final_confidence}%*\n"
            f"💰 Amount: *${trade_amount:.2f}*\n"
            f"━━━━━━━━━━━━━\n"
            f"_Educational purposes only_"
        )
        
        def send_go_now():
            time.sleep(45)
            go_time = (datetime.utcnow() + timedelta(hours=1)).strftime("%H:%M:%S WAT")
            send_telegram(
                f"🔥 *GO NOW!*\n"
                f"━━━━━━━━━━━━━\n"
                f"{'🟢⬆️' if final_direction == 'CALL' else '🔴⬇️'} *{final_direction}* — *{pair}*\n"
                f"⌛ Expiry: *{expiry}*\n"
                f"⚠️ *VOID after 15 seconds!*\n"
                f"━━━━━━━━━━━━━\n"
                f"_Educational purposes only_"
            )
        threading.Thread(target=send_go_now, daemon=True).start()
        
        if auto_trade and iq_connected and iq:
            try:
                clean_pair = pair.replace("/", "")
                iq.change_balance("PRACTICE")
                check, iq_id = iq.buy(trade_amount, clean_pair, final_direction.lower(), expiry_mins)
                if check:
                    logger.info(f"Auto trade: {final_direction} {clean_pair} ${trade_amount:.2f}")
            except Exception as e:
                logger.error(f"Auto trade error: {e}")
        
        return {"status": "ok", "trade_uuid": trade_uuid, "amount": trade_amount}
        
    except Exception as e:
        logger.error(f"Alert error: {e}")
        return {"status": "error", "message": str(e)}
    finally:
        db.close()

@app.get("/trades")
def get_trades(limit: int = 50):
    db = SessionLocal()
    trades = db.query(Trade).order_by(Trade.timestamp.desc()).limit(limit).all()
    db.close()
    return {"status": "ok", "trades": [
        {"trade_uuid": t.trade_uuid, "pair": t.pair, "direction": t.direction,
         "result": t.result, "confidence": t.confidence, "amount": t.amount,
         "timestamp": t.timestamp.isoformat()} for t in trades
    ]}

@app.get("/stats")
def get_stats():
    db = SessionLocal()
    trades = db.query(Trade).all()
    labeled = db.query(SequenceData).count()
    db.close()
    
    total = len(trades)
    wins = sum(1 for t in trades if t.result == "WIN")
    losses = sum(1 for t in trades if t.result == "LOSS")
    win_rate = round((wins / total) * 100, 1) if total > 0 else 0
    
    return {"status": "ok", "stats": {
        "total_trades": total, "wins": wins, "losses": losses,
        "win_rate": win_rate, "labeled_sequences": labeled,
        "ml_enabled": ml_enabled, "min_required": ML_MIN_SEQUENCES,
        "model_ready": model is not None, "session": session_state.get_summary()
    }}

@app.get("/ml/status")
def ml_status():
    db = SessionLocal()
    labeled = db.query(SequenceData).count()
    db.close()
    return {
        "status": "ok",
        "ml_enabled": ml_enabled,
        "labeled_sequences": labeled,
        "min_required": ML_MIN_SEQUENCES,
        "edge_threshold": EDGE_THRESHOLD,
        "model_ready": model is not None
    }

@app.post("/ml/train")
def force_train():
    threading.Thread(target=lambda: train_models(), daemon=True).start()
    return {"status": "ok", "message": "Training started"}

@app.post("/test_telegram")
def test_telegram():
    success = send_telegram("Signal Wolf v8.1 - Online")
    return {"status": "ok" if success else "error"}

# ──────────────────────────────────────────────────────────────────────────────
# STARTUP
# ──────────────────────────────────────────────────────────────────────────────

load_latest_model()
threading.Thread(target=training_loop, daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)