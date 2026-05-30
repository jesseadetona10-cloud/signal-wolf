import { useState, useEffect, useRef } from "react"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  "https://adqbzevgyatcfampmdpa.supabase.co",
  "sb_publishable_bkB7-JIPSR9DXd7X8ytUAw_9nFHwLn_"
)

const SCAN_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "NZD/CAD", "AUD/USD",
  "EUR/GBP", "USD/CHF", "GBP/JPY", "EUR/JPY", "AUD/JPY",
  "EUR/CHF", "GBP/AUD", "USD/CAD", "EUR/CAD", "GBP/CHF",
  "AUD/NZD", "EUR/AUD", "AUD/CAD"
]

const TWELVE_DATA_KEY = "4d2e88baa526473b904952db67c46d02"
const PAYOUT = 0.8

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }

// ──────────────────────────────────────────────────────────────────────────────
// DATA FETCHING
// ──────────────────────────────────────────────────────────────────────────────

async function fetchCandles(pair, limit = 100) {
  try {
    const symbol = pair.replace("/", "") + "=X"
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`)
    const data = await res.json()
    const result = data.chart.result[0]
    const quote = result.indicators.quote[0]
    const timestamps = result.timestamp
    const candles = []
    for (let i = 0; i < timestamps.length; i++) {
      if (quote.open[i] && quote.high[i] && quote.low[i] && quote.close[i]) {
        candles.push({
          time: timestamps[i],
          open: quote.open[i], high: quote.high[i],
          low: quote.low[i], close: quote.close[i]
        })
      }
    }
    if (candles.length >= 30) return candles.slice(-limit)
    throw new Error("Not enough data")
  } catch {
    const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${pair}&interval=1min&outputsize=${limit}&apikey=${TWELVE_DATA_KEY}`)
    const data = await res.json()
    if (!data.values?.length) throw new Error("No price data")
    return data.values.map(c => ({
      time: new Date(c.datetime).getTime(),
      open: parseFloat(c.open), high: parseFloat(c.high),
      low: parseFloat(c.low), close: parseFloat(c.close)
    })).reverse()
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// INDICATORS
// ──────────────────────────────────────────────────────────────────────────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0.0001
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1]
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev.close),
      Math.abs(candles[i].low - prev.close)
    )
  }
  return sum / period
}

function hasVolatilitySpike(candles) {
  if (candles.length < 10) return false
  const atr = calcATR(candles)
  const recentRanges = candles.slice(-5).map(c => c.high - c.low)
  return avg(recentRanges) > atr * 2.5
}

function getHTFTrend(candles) {
  if (candles.length < 60) return "RANGE"
  const closes = candles.map(c => c.close)
  const sma20 = avg(closes.slice(-20))
  const sma50 = avg(closes.slice(-50))
  const atr = calcATR(candles)
  const displacement = Math.abs(sma20 - sma50)
  if (sma20 > sma50 && displacement > atr * 0.5) return "BULL"
  if (sma20 < sma50 && displacement > atr * 0.5) return "BEAR"
  return "RANGE"
}

function isChoppy(candles) {
  if (candles.length < 20) return true
  const ranges = candles.slice(-20).map(c => c.high - c.low)
  const avgRange = avg(ranges)
  const variance = avg(ranges.map(r => Math.abs(r - avgRange)))
  return variance < avgRange * 0.5
}

function findSwingPoints(candles) {
  const highs = [], lows = []
  for (let i = 3; i < candles.length - 3; i++) {
    let isHigh = true, isLow = true
    for (let j = -3; j <= 3; j++) {
      if (j === 0) continue
      if (candles[i].high <= candles[i + j].high) isHigh = false
      if (candles[i].low >= candles[i + j].low) isLow = false
    }
    if (isHigh) highs.push({ price: candles[i].high, index: i })
    if (isLow) lows.push({ price: candles[i].low, index: i })
  }
  return { highs, lows }
}

function liquiditySweep(candles, bias) {
  if (candles.length < 40) return { triggered: false, strength: 0 }
  const { highs, lows } = findSwingPoints(candles.slice(0, -10))
  const lastSwingHigh = highs[highs.length - 1]
  const lastSwingLow = lows[lows.length - 1]
  if (!lastSwingHigh || !lastSwingLow) return { triggered: false, strength: 0 }
  const atr = calcATR(candles)
  for (let i = Math.max(0, candles.length - 15); i < candles.length - 1; i++) {
    const candle = candles[i], next = candles[i + 1]
    if (bias === "BULL") {
      const sweepsLow = candle.low < lastSwingLow.price
      const depth = lastSwingLow.price - candle.low
      const reclaims = next.close > lastSwingLow.price
      if (sweepsLow && depth > atr * 0.4 && reclaims) {
        return { triggered: true, strength: Math.min((depth / atr) + (next.close - lastSwingLow.price) / atr, 3) }
      }
    }
    if (bias === "BEAR") {
      const sweepsHigh = candle.high > lastSwingHigh.price
      const depth = candle.high - lastSwingHigh.price
      const rejects = next.close < lastSwingHigh.price
      if (sweepsHigh && depth > atr * 0.4 && rejects) {
        return { triggered: true, strength: Math.min((depth / atr) + (candle.high - lastSwingHigh.price) / atr, 3) }
      }
    }
  }
  return { triggered: false, strength: 0 }
}

function isBreakStructure(candles, bias) {
  const { highs, lows } = findSwingPoints(candles)
  const last = candles[candles.length - 1]
  if (bias === "BULL") {
    const lastHigh = highs[highs.length - 1]
    if (!lastHigh) return false
    return last.close > lastHigh.price
  }
  if (bias === "BEAR") {
    const lastLow = lows[lows.length - 1]
    if (!lastLow) return false
    return last.close < lastLow.price
  }
  return false
}

function isExpansion(candles) {
  if (candles.length < 30) return { triggered: false, strength: 0 }
  const ranges = candles.slice(-25).map(c => c.high - c.low)
  const recent = ranges.slice(-5)
  const base = avg(ranges.slice(0, -5))
  const strongMoves = recent.filter(r => r > base * 1.4).length
  const veryStrong = recent.filter(r => r > base * 1.8).length
  return { triggered: strongMoves >= 3, strength: veryStrong >= 1 ? 2 : strongMoves >= 3 ? 1 : 0 }
}

function isMicroBreak(candles, bias) {
  if (candles.length < 6) return false
  const recentHigh = Math.max(...candles.slice(-5, -1).map(c => c.high))
  const recentLow = Math.min(...candles.slice(-5, -1).map(c => c.low))
  const last = candles[candles.length - 1]
  return bias === "BULL" ? last.close > recentHigh : last.close < recentLow
}

function isEntryConfirmed(candles, bias) {
  if (candles.length < 3) return false
  const [a, b, c] = [candles[candles.length - 3], candles[candles.length - 2], candles[candles.length - 1]]
  if (bias === "BULL") {
    const engulf = c.close > b.open && b.close < b.open && c.close > a.close
    const strong = c.close > b.close && (c.close - b.close) > (b.close - a.close) * 1.5
    const hammer = c.close > c.open && c.low < b.low && (c.close - c.low) > (c.high - c.close) * 2
    return engulf || strong || hammer
  }
  if (bias === "BEAR") {
    const engulf = c.close < b.open && b.close > b.open && c.close < a.close
    const strong = c.close < b.close && (b.close - c.close) > (a.close - b.close) * 1.5
    const star = c.close < c.open && c.high > b.high && (c.high - c.close) > (c.close - c.low) * 2
    return engulf || strong || star
  }
  return false
}

function runInstitutional(candles, bias) {
  if (isChoppy(candles)) return null
  const sweep = liquiditySweep(candles, bias)
  const bos = isBreakStructure(candles, bias)
  const expansion = isExpansion(candles)
  const microBreak = isMicroBreak(candles, bias)
  const entryConfirmed = isEntryConfirmed(candles, bias)
  if (!sweep.triggered && !bos) return null
  if (!expansion.triggered && !microBreak && !entryConfirmed) return null
  let score = 0
  if (sweep.triggered) score += sweep.strength * 8
  if (bos) score += 10
  if (expansion.triggered) score += 10 + expansion.strength * 10
  if (entryConfirmed) score += 10
  if (microBreak) score += 8
  const confidence = Math.min(score, 95)
  const grade = confidence >= 80 ? "A+" : confidence >= 70 ? "A" : confidence >= 60 ? "B" : "C"
  const autoExpiry = grade === "A+" ? "1M" : grade === "A" ? "3M" : "5M"
  return { confidence, grade, autoExpiry, hasSweep: sweep.triggered, hasBos: bos, hasExpansion: expansion.triggered }
}

// ──────────────────────────────────────────────────────────────────────────────
// VOTING ENGINE (Fallback)
// ──────────────────────────────────────────────────────────────────────────────

function calcRSI(closes, period = 7) {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  return 100 - 100 / (1 + gains / (losses || 0.0001))
}

function calcStoch(closes, k = 5) {
  if (closes.length < k) return 50
  const slice = closes.slice(-k)
  const high = Math.max(...slice), low = Math.min(...slice)
  return ((closes[closes.length - 1] - low) / (high - low || 0.0001)) * 100
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return 0.5
  const slice = closes.slice(-period)
  const mean = avg(slice)
  const std = Math.sqrt(avg(slice.map(x => (x - mean) ** 2)))
  const cur = closes[closes.length - 1]
  return (cur - (mean - 2 * std)) / (4 * std || 0.0001)
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1)
  let ema = closes[0]
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k)
  return ema
}

function calcMACD(closes) {
  if (closes.length < 27) return 0
  const fast = calcEMA(closes.slice(-12), 12)
  const slow = calcEMA(closes.slice(-26), 26)
  const macd = fast - slow
  const signal = (macd + (calcEMA(closes.slice(-13, -1), 12) - calcEMA(closes.slice(-27, -1), 26))) / 2
  return macd - signal
}

function calcCCI(closes, period = 14) {
  if (closes.length < period + 1) return 0
  const slice = closes.slice(-period)
  const mean = avg(slice)
  const meanDev = avg(slice.map(x => Math.abs(x - mean)))
  return (closes[closes.length - 1] - mean) / (0.015 * (meanDev || 0.0001))
}

function runVoting(candles) {
  const closes = candles.map(c => c.close)
  const rsi = calcRSI(closes)
  const stoch = calcStoch(closes)
  const bb = calcBB(closes)
  const macd = calcMACD(closes)
  const cci = calcCCI(closes)
  const indicators = [
    { name: "RSI", value: rsi.toFixed(1), vote: rsi < 30 ? "CALL" : rsi > 70 ? "PUT" : "NEUTRAL", detail: rsi < 30 ? "Oversold" : rsi > 70 ? "Overbought" : "Neutral" },
    { name: "STOCH", value: stoch.toFixed(1), vote: stoch < 20 ? "CALL" : stoch > 80 ? "PUT" : "NEUTRAL", detail: stoch < 20 ? "Oversold" : stoch > 80 ? "Overbought" : "Mid" },
    { name: "BB", value: bb.toFixed(2), vote: bb < 0.1 ? "CALL" : bb > 0.9 ? "PUT" : "NEUTRAL", detail: bb < 0.1 ? "Lower" : bb > 0.9 ? "Upper" : "Mid" },
    { name: "MACD", value: macd.toFixed(5), vote: macd > 0 ? "CALL" : macd < 0 ? "PUT" : "NEUTRAL", detail: macd > 0 ? "Bull" : "Bear" },
    { name: "CCI", value: cci.toFixed(1), vote: cci < -100 ? "CALL" : cci > 100 ? "PUT" : "NEUTRAL", detail: cci < -100 ? "Oversold" : cci > 100 ? "Overbought" : "Normal" },
  ]
  const calls = indicators.filter(i => i.vote === "CALL").length
  const puts = indicators.filter(i => i.vote === "PUT").length
  const votes = Math.max(calls, puts)
  const direction = calls >= 4 ? "CALL" : puts >= 4 ? "PUT" : "NO TRADE"
  const confidence = Math.round((votes / 5) * 100)
  const autoExpiry = votes === 5 ? "1M" : "5M"
  return { direction, votes, confidence, autoExpiry, indicators, grade: votes === 5 ? "B" : "C" }
}

// ──────────────────────────────────────────────────────────────────────────────
// MERGED ANALYSIS
// ──────────────────────────────────────────────────────────────────────────────

async function analysePair(pair) {
  try {
    const candles = await fetchCandles(pair, 100)
    if (hasVolatilitySpike(candles)) {
      return { pair, direction: "NO TRADE", confidence: 0, grade: "—", votes: 0, autoExpiry: "5M", indicators: [], engine: "blocked", reason: "Volatility spike" }
    }
    const trend = getHTFTrend(candles)
    if (trend !== "RANGE") {
      const inst = runInstitutional(candles, trend)
      if (inst) {
        const direction = trend === "BULL" ? "CALL" : "PUT"
        return {
          pair, direction, confidence: inst.confidence, grade: inst.grade,
          votes: Math.round(inst.confidence / 20), autoExpiry: inst.autoExpiry,
          indicators: [
            { name: "BIAS", value: trend, vote: direction, detail: "HTF" },
            { name: "SWEEP", value: inst.hasSweep ? "YES" : "NO", vote: inst.hasSweep ? direction : "NEUTRAL", detail: "Liquidity sweep" },
            { name: "BOS", value: inst.hasBos ? "YES" : "NO", vote: inst.hasBos ? direction : "NEUTRAL", detail: "Break of structure" },
            { name: "EXPAND", value: inst.hasExpansion ? "YES" : "NO", vote: inst.hasExpansion ? direction : "NEUTRAL", detail: "Expansion" },
            { name: "ENTRY", value: "VALID", vote: direction, detail: "Entry confirmed" },
          ],
          engine: "institutional",
          reason: `${inst.grade} · Sweep:${inst.hasSweep ? "+" : "-"} BOS:${inst.hasBos ? "+" : "-"} Exp:${inst.hasExpansion ? "+" : "-"}`
        }
      }
    }
    const voting = runVoting(candles)
    if (voting.direction !== "NO TRADE") {
      return {
        pair, direction: voting.direction, confidence: voting.confidence,
        grade: voting.grade, votes: voting.votes, autoExpiry: voting.autoExpiry,
        indicators: voting.indicators, engine: "voting",
        reason: `${voting.votes}/5 indicators agree`
      }
    }
    return { pair, direction: "NO TRADE", confidence: 0, grade: "—", votes: 0, autoExpiry: "5M", indicators: [], engine: "none", reason: "No signal" }
  } catch {
    return { pair, direction: "NO TRADE", confidence: 0, grade: "—", votes: 0, autoExpiry: "5M", indicators: [], engine: "error", reason: "Fetch error" }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// THEME
// ──────────────────────────────────────────────────────────────────────────────

const S = {
  bg: "#0a0e17",
  surface: "#111827",
  card: "#131b2c",
  border: "#1e2d40",
  green: "#00d4aa",
  greenFaint: "#00d4aa18",
  red: "#ff4466",
  redFaint: "#ff446618",
  cyan: "#38bdf8",
  yellow: "#f5a623",
  text: "#e2e8f0",
  muted: "#64748b",
  dim: "#334155",
}

// ──────────────────────────────────────────────────────────────────────────────
// ENTRY TIMING
// ──────────────────────────────────────────────────────────────────────────────

function calculateEntryTime(signal) {
  if (!signal || signal.direction === "NO TRADE") return null
  const now = new Date()
  const seconds = now.getSeconds()
  const nextMinute = 60 - seconds
  const nextHalfMinute = 30 - (seconds % 30)
  if (signal.grade === "A+") {
    return { seconds: nextMinute, message: `Enter at :00 (in ${nextMinute}s)`, instruction: `Place ${signal.direction === "CALL" ? "BUY" : "SELL"} at :00` }
  } else if (signal.grade === "A") {
    const target = seconds % 30 < 15 ? 30 : 0
    return { seconds: nextHalfMinute, message: `Enter at :${String(target).padStart(2,"0")} (in ${nextHalfMinute}s)`, instruction: `Place ${signal.direction === "CALL" ? "BUY" : "SELL"} at :${String(target).padStart(2,"0")}` }
  } else {
    return { seconds: 5, message: "Enter NOW within 5s", instruction: `Place ${signal.direction === "CALL" ? "BUY" : "SELL"} immediately` }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// APP
// ──────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("scanner")
  const [signal, setSignal] = useState(null)
  const signalRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const scanIntervalRef = useRef(null)
  const [countdown, setCountdown] = useState(60)
  const countdownRef = useRef(60)
  const [lastScan, setLastScan] = useState(null)
  const [scanResults, setScanResults] = useState([])
  const [time, setTime] = useState(new Date())
  const [wins, setWins] = useState(0)
  const [losses, setLosses] = useState(0)
  const [tradeHistory, setTradeHistory] = useState([])
  const [newsShield, setNewsShield] = useState({ safe: true, events: [], blocking: null })
  const [iqConnected, setIqConnected] = useState(false)
  const [iqBalance, setIqBalance] = useState(null)
  const [autoTrade, setAutoTrade] = useState(false)
  const [sessionActive, setSessionActive] = useState(() => localStorage.getItem("sw_active") === "true")
  const [sessionTarget, setSessionTarget] = useState(() => Number(localStorage.getItem("sw_target") || 50))
  const [tradeAmount, setTradeAmount] = useState(() => Number(localStorage.getItem("sw_amount") || 5))
  const tradeAmountRef = useRef(Number(localStorage.getItem("sw_amount") || 5))
  const sessionTargetRef = useRef(Number(localStorage.getItem("sw_target") || 50))
  const [sessionProfit, setSessionProfit] = useState(() => Number(localStorage.getItem("sw_profit") || 0))
  const sessionProfitRef = useRef(Number(localStorage.getItem("sw_profit") || 0))
  const [killSwitch, setKillSwitch] = useState(() => localStorage.getItem("sw_killswitch") === "true")
  const consecutiveLossesRef = useRef(0)
  const [showSetup, setShowSetup] = useState(false)
  const [error, setError] = useState(null)
  const [manualPair, setManualPair] = useState("EUR/USD")
  const [manualDir, setManualDir] = useState("CALL")
  const [manualTime, setManualTime] = useState("12:00")
  const [manualResult, setManualResult] = useState(null)
  const [manualLoading, setManualLoading] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900)
  const newsShieldRef = useRef({ safe: true })
  const [entryTimer, setEntryTimer] = useState(null)
  const [entryCountdown, setEntryCountdown] = useState(null)
  const entryIntervalRef = useRef(null)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 900)
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    supabase.from("trades").select("*").order("created_at", { ascending: false }).limit(30)
      .then(({ data }) => {
        if (!data) return
        setWins(data.filter(t => t.result === "WIN").length)
        setLosses(data.filter(t => t.result === "LOSS").length)
        setTradeHistory(data.map(t => ({
          pair: t.pair, direction: t.direction, expiry: t.expiry,
          result: t.result, confidence: t.confidence,
          time: new Date(t.created_at).toLocaleTimeString(),
          pnl: t.result === "WIN" ? tradeAmount * PAYOUT : -tradeAmount
        })))
      }).catch(() => {})
  }, [])

  useEffect(() => {
    const check = () => fetch("http://127.0.0.1:8000/news")
      .then(r => r.json())
      .then(d => {
        const shield = { safe: d.safe, events: d.events || [], blocking: d.blocking_event }
        setNewsShield(shield)
        newsShieldRef.current = shield
      }).catch(() => {})
    check()
    const interval = setInterval(check, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    fetch("http://127.0.0.1:8000/iq/status")
      .then(r => r.json())
      .then(d => {
        setIqConnected(d.connected)
        if (d.connected) {
          fetch("http://127.0.0.1:8000/iq/balance")
            .then(r => r.json()).then(d => setIqBalance(d.balance)).catch(() => {})
        }
      }).catch(() => {})
  }, [])

    // Save session state to localStorage
    useEffect(() => {
      localStorage.setItem("sw_target", sessionTarget)
      localStorage.setItem("sw_amount", tradeAmount)
      localStorage.setItem("sw_profit", sessionProfit)
      localStorage.setItem("sw_active", sessionActive)
      localStorage.setItem("sw_killswitch", killSwitch)
    }, [sessionTarget, tradeAmount, sessionProfit, sessionActive, killSwitch])

  const gmtH = time.getUTCHours(), gmtM = time.getUTCMinutes(), gmtS = time.getUTCSeconds()
  const watH = (gmtH + 1) % 24
  const watTime = `${String(watH).padStart(2, "0")}:${String(gmtM).padStart(2, "0")}:${String(gmtS).padStart(2, "0")} WAT`
  const winRate = wins + losses === 0 ? 0 : Math.round((wins / (wins + losses)) * 100)

  async function runFullScan() {
    if (killSwitch) return
    if (!newsShieldRef.current.safe) {
      setError(`News Shield active: ${newsShieldRef.current.blocking}`)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all(SCAN_PAIRS.map(p => analysePair(p)))
      setScanResults(results)
      const valid = results.filter(r => r.direction !== "NO TRADE")
      if (valid.length === 0) {
        const noTrade = { direction: "NO TRADE", pair: "—", confidence: 0, grade: "—", votes: 0, indicators: [], autoExpiry: "5M" }
        setSignal(noTrade)
        signalRef.current = noTrade
        if (entryIntervalRef.current) clearInterval(entryIntervalRef.current)
        setEntryTimer(null)
        setEntryCountdown(null)
      } else {
        const gradeOrder = { "A+": 5, "A": 4, "B": 3, "C": 2, "—": 1 }
        const best = valid.sort((a, b) => (gradeOrder[b.grade] || 0) - (gradeOrder[a.grade] || 0) || b.confidence - a.confidence)[0]
        setSignal(best)
        signalRef.current = best
        setLastScan(new Date().toLocaleTimeString())
        
        if (entryIntervalRef.current) clearInterval(entryIntervalRef.current)
        const timing = calculateEntryTime(best)
        if (timing) {
          setEntryTimer(timing)
          setEntryCountdown(timing.seconds)
          let remaining = timing.seconds
          entryIntervalRef.current = setInterval(() => {
            remaining -= 1
            setEntryCountdown(remaining)
            if (remaining <= 0) {
              clearInterval(entryIntervalRef.current)
              setEntryCountdown(0)
              fetch("http://127.0.0.1:8000/alert", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "GO_NOW",
                  pair: best.pair,
                  direction: best.direction,
                  grade: best.grade,
                  confidence: best.confidence,
                  expiry: best.autoExpiry,
                  trade_uuid: best.trade_uuid
                })
              }).catch(() => {})
            }
          }, 1000)
        }
        
        try {
          await fetch("http://127.0.0.1:8000/alert", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "SIGNAL",
              pair: best.pair,
              direction: best.direction,
              confidence: best.confidence,
              votes: best.votes,
              expiry: best.autoExpiry,
              amount: tradeAmountRef.current,
              auto_trade: autoTrade,
              indicators: best.indicators,
              grade: best.grade,
              engine: best.engine
            })
          })
        } catch {}
      }
    } catch {
      setError("Scan failed")
    }
    setLoading(false)
  }

  function startScanner() {
    setScanning(true)
    runFullScan()
    countdownRef.current = 60
    setCountdown(60)
    const interval = setInterval(() => {
      countdownRef.current -= 1
      setCountdown(countdownRef.current)
      if (countdownRef.current <= 0) {
        countdownRef.current = 60
        setCountdown(60)
        if (!signalRef.current || signalRef.current.direction === "NO TRADE") {
          runFullScan()
        }
      }
    }, 1000)
    scanIntervalRef.current = interval
  }

  function stopScanner() {
    setScanning(false)
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current)
      scanIntervalRef.current = null
    }
    if (entryIntervalRef.current) {
      clearInterval(entryIntervalRef.current)
      entryIntervalRef.current = null
    }
    countdownRef.current = 60
    setCountdown(60)
    setEntryTimer(null)
    setEntryCountdown(null)
  }

  async function handleResult(result) {
    const amount = tradeAmountRef.current
    const pnl = result === "WIN" ? amount * PAYOUT : -amount
    const newProfit = sessionProfitRef.current + pnl
    sessionProfitRef.current = newProfit
    setSessionProfit(newProfit)

    if (result === "WIN") {
      setWins(w => w + 1)
      consecutiveLossesRef.current = 0
    } else {
      setLosses(l => l + 1)
      consecutiveLossesRef.current += 1
    }

    const trade = {
      pair: signal.pair,
      direction: signal.direction,
      expiry: signal.autoExpiry || "5M",
      result,
      confidence: signal.confidence,
      time: new Date().toLocaleTimeString(),
      pnl
    }
    setTradeHistory(prev => [trade, ...prev.slice(0, 29)])

    try {
      await supabase.from("trades").insert({
        pair: trade.pair,
        direction: trade.direction,
        expiry: trade.expiry,
        confidence: trade.confidence,
        votes: signal.votes,
        result,
        pnl: trade.pnl
      })
    } catch {}

    try {
      await fetch("http://127.0.0.1:8000/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "TRADE_RESULT",
          pair: signal.pair,
          direction: signal.direction,
          result,
          pnl,
          totalProfit: newProfit,
          target: sessionTargetRef.current,
          trade_uuid: signal.trade_uuid
        })
      })
    } catch {}

    if (consecutiveLossesRef.current >= 3) {
      setKillSwitch(true)
      stopScanner()
      setSessionActive(false)
    }

    if (newProfit >= sessionTargetRef.current) {
      stopScanner()
      setSessionActive(false)
    }

    setSignal(null)
    signalRef.current = null
  }

  async function handleManualValidate() {
    setManualLoading(true)
    setManualResult(null)
    try {
      const result = await analysePair(manualPair)
      const [h, m] = manualTime.split(":").map(Number)
      const addMins = mins => { const t = h * 60 + m + mins; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` }
      const directionMatch = result.direction === manualDir
      
      const timing = calculateEntryTime({ ...result, direction: manualDir, grade: result.grade })
      
      let verdict, color, suggestion
      if (directionMatch && result.confidence >= 60) {
        verdict = "CONFIRMED"
        color = S.green
        suggestion = `${result.grade} signal on ${manualPair}. ${result.reason}`
      } else if (directionMatch && result.confidence >= 40) {
        verdict = "WEAK"
        color = S.yellow
        suggestion = `Low confidence. Wait until ${addMins(5)}.`
      } else {
        verdict = "REJECTED"
        color = S.red
        suggestion = `Bot sees ${result.direction !== "NO TRADE" ? result.direction : "no signal"}, not ${manualDir}. Try ${addMins(5)}.`
      }
      setManualResult({
        verdict, color, suggestion,
        indicators: result.indicators,
        grade: result.grade,
        confidence: result.confidence,
        engine: result.engine,
        betterTime: addMins(5),
        entryTiming: timing
      })
    } catch {
      setError("Could not fetch prices")
    }
    setManualLoading(false)
  }

  const signalColor = signal?.direction === "CALL" ? S.green : signal?.direction === "PUT" ? S.red : S.muted
  const gradeColor = g => g === "A+" ? S.green : g === "A" ? S.cyan : g === "B" ? S.yellow : S.muted

  return (
    <div style={{ background: S.bg, minHeight: "100vh", fontFamily: "'SF Mono','Fira Code',monospace", color: S.text }}>

      {showSetup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 20, padding: 32, width: "100%", maxWidth: 380 }}>
            <div style={{ fontSize: 10, color: S.muted, letterSpacing: 3, marginBottom: 4 }}>SIGNAL WOLF</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Session Setup</div>
            <div style={{ fontSize: 11, color: S.muted, marginBottom: 24 }}>v8.1 - Kelly Sizing · Max 2 trades</div>

            <div style={{ fontSize: 10, color: S.muted, letterSpacing: 2, marginBottom: 8 }}>PROFIT TARGET ($)</div>
            <input type="number" value={sessionTarget} onChange={e => { setSessionTarget(Number(e.target.value)); sessionTargetRef.current = Number(e.target.value) }}
              style={{ width: "100%", padding: "12px 16px", marginBottom: 16, background: S.surface, border: `1px solid ${S.border}`, borderRadius: 10, color: S.text, fontSize: 16 }} />

            <div style={{ fontSize: 10, color: S.muted, letterSpacing: 2, marginBottom: 8 }}>TRADE AMOUNT ($)</div>
            <input type="number" value={tradeAmount} onChange={e => { setTradeAmount(Number(e.target.value)); tradeAmountRef.current = Number(e.target.value) }}
              style={{ width: "100%", padding: "12px 16px", marginBottom: 20, background: S.surface, border: `1px solid ${S.border}`, borderRadius: 10, color: S.text, fontSize: 16 }} />

            <div style={{ fontSize: 10, color: S.muted, lineHeight: 2, marginBottom: 20, padding: "12px 14px", background: S.surface, borderRadius: 10 }}>
              A+ → 1M expiry + :00 entry<br />
              A → 3M expiry + half-minute entry<br />
              B/C → 5M expiry + immediate entry<br />
              Kelly position sizing active<br />
              Max 2 concurrent trades
            </div>

            <button onClick={async () => {
              tradeAmountRef.current = Number(tradeAmount)
              sessionTargetRef.current = Number(sessionTarget)
              setShowSetup(false)
              setSessionActive(true)
              sessionProfitRef.current = 0
              setSessionProfit(0)
              consecutiveLossesRef.current = 0
              setKillSwitch(false)
              try {
                await fetch("http://127.0.0.1:8000/alert", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "SESSION_START", target: sessionTarget, amount: tradeAmount })
                })
              } catch {}
                localStorage.setItem("sw_profit", 0)
                localStorage.setItem("sw_active", "true")
                localStorage.setItem("sw_killswitch", "false")
              startScanner()
            }} style={{ width: "100%", padding: 14, background: S.green, border: "none", color: "#000", fontWeight: 700, borderRadius: 10, cursor: "pointer", marginBottom: 8 }}>
              START SESSION
            </button>
            <button onClick={() => setShowSetup(false)} style={{ width: "100%", padding: 12, background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: 10, cursor: "pointer" }}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      <div style={{ background: S.surface, borderBottom: `1px solid ${S.border}`, padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: S.green, letterSpacing: 2 }}>SIGNAL WOLF v8.1</div>
          <div style={{ width: 1, height: 20, background: S.border }} />
          <div style={{ fontSize: 10, color: S.muted }}>18 PAIRS</div>
          <div style={{ width: 1, height: 20, background: S.border }} />
          <div style={{ fontSize: 10, color: S.muted }}>LSTM + KELLY</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {!newsShield.safe && <div style={{ fontSize: 9, color: S.red, padding: "2px 8px", border: `1px solid ${S.red}44`, borderRadius: 4 }}>NEWS BLOCKED</div>}
          <div style={{ fontSize: 10, color: iqConnected ? S.green : S.muted }}>IQ {iqConnected ? (iqBalance ? `$${Number(iqBalance).toFixed(0)}` : "LIVE") : "OFF"}</div>
          <div style={{ fontSize: 11, fontWeight: 600 }}>{watTime}</div>
        </div>
      </div>

      <div style={{ background: S.surface, borderBottom: `1px solid ${S.border}`, padding: "8px 24px", display: "flex", gap: 28, alignItems: "center", overflowX: "auto" }}>
        <div><span style={{ fontSize: 9, color: S.muted }}>WIN RATE</span> <span style={{ fontSize: 15, fontWeight: 700, color: winRate >= 56 ? S.green : winRate >= 50 ? S.yellow : S.red }}>{winRate}%</span></div>
        <div><span style={{ fontSize: 9, color: S.muted }}>WINS</span> <span style={{ fontSize: 15, fontWeight: 700, color: S.green }}>{wins}</span></div>
        <div><span style={{ fontSize: 9, color: S.muted }}>LOSSES</span> <span style={{ fontSize: 15, fontWeight: 700, color: S.red }}>{losses}</span></div>
        <div><span style={{ fontSize: 9, color: S.muted }}>TRADES</span> <span style={{ fontSize: 15, fontWeight: 700 }}>{wins + losses}</span></div>
        {sessionActive && (
          <>
            <div style={{ width: 1, height: 20, background: S.border }} />
            <div><span style={{ fontSize: 9, color: S.muted }}>P&L</span> <span style={{ fontSize: 15, fontWeight: 700, color: sessionProfit >= 0 ? S.green : S.red }}>{sessionProfit >= 0 ? "+" : ""}${sessionProfit.toFixed(2)}</span></div>
            <div style={{ width: 60, height: 3, background: S.border, borderRadius: 2 }}><div style={{ height: "100%", width: `${Math.min(Math.max((sessionProfit / sessionTarget) * 100, 0), 100)}%`, background: S.green, borderRadius: 2 }} /></div>
          </>
        )}
        {killSwitch && <div style={{ fontSize: 9, color: S.red, padding: "3px 10px", border: `1px solid ${S.red}44`, borderRadius: 4 }}>KILL SWITCH</div>}
        {error && <div style={{ fontSize: 9, color: S.red }}>{error}</div>}
      </div>

      <div style={{ display: "flex", borderBottom: `1px solid ${S.border}` }}>
        {["scanner", "pairs", "validate", "history"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "12px 0", background: "transparent", border: "none",
            borderBottom: `2px solid ${tab === t ? S.green : "transparent"}`,
            color: tab === t ? S.green : S.muted, fontSize: 10, letterSpacing: 2, cursor: "pointer"
          }}>{t.toUpperCase()}</button>
        ))}
      </div>

      <div style={{ padding: 20 }}>

        {tab === "scanner" && (
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 300px", gap: 16, maxWidth: 1100, margin: "0 auto" }}>
            <div>
              {scanning && (
                <div style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 12, padding: "14px 20px", marginBottom: 12, display: "flex", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
                  <div><div style={{ fontSize: 9, color: S.muted }}>NEXT SCAN</div><div style={{ fontSize: 28, fontWeight: 700, color: countdown <= 10 ? S.red : S.green }}>{countdown}s</div></div>
                  <div><div style={{ fontSize: 9, color: S.muted }}>STATUS</div><div style={{ fontSize: 11, color: S.green }}>18 PAIRS</div></div>
                  <div><div style={{ fontSize: 9, color: S.muted }}>LAST</div><div style={{ fontSize: 11 }}>{lastScan || "—"}</div></div>
                  <div style={{ position: "absolute", bottom: 0, left: 0, height: 2, width: `${((60 - countdown) / 60) * 100}%`, background: S.green }} />
                </div>
              )}

              <div style={{ background: S.card, border: `1px solid ${signal?.direction !== "NO TRADE" && signal ? signalColor + "55" : S.border}`, borderRadius: 16, padding: "36px 28px", textAlign: "center", position: "relative" }}>
                {signal?.direction !== "NO TRADE" && signal && <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 0%, ${signalColor}10 0%, transparent 65%)`, pointerEvents: "none" }} />}
                {loading ? (
                  <div><div style={{ fontSize: 10, color: S.muted }}>SCANNING 18 PAIRS</div><div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>{[0.2, 0.45, 0.7, 0.95].map((o, i) => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: S.green, opacity: o }} />)}</div></div>
                ) : signal ? (
                  <>
                    {signal.direction !== "NO TRADE" && (
                      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: S.muted }}>{signal.pair}</span><span style={{ fontSize: 9, color: S.dim }}>·</span>
                        <span style={{ fontSize: 9, color: S.muted }}>{signal.autoExpiry}</span><span style={{ fontSize: 9, color: S.dim }}>·</span>
                        <span style={{ fontSize: 9, padding: "1px 8px", borderRadius: 4, background: gradeColor(signal.grade) + "22", color: gradeColor(signal.grade) }}>{signal.grade}</span>
                        <span style={{ fontSize: 9, color: S.dim }}>·</span>
                        <span style={{ fontSize: 9, color: signal.engine === "institutional" ? S.cyan : S.yellow }}>{signal.engine === "institutional" ? "INST" : "VOTE"}</span>
                      </div>
                    )}
                    {signal.direction !== "NO TRADE" && entryTimer && (
                      <div style={{ marginBottom: 20, padding: "10px 16px", background: entryCountdown <= 3 ? S.redFaint : S.surface, borderRadius: 10, border: `1px solid ${entryCountdown <= 3 ? S.red : S.green}44` }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: entryCountdown <= 3 ? S.red : S.green }}>{entryTimer.message}</div>
                        {entryCountdown > 0 && <div style={{ fontSize: 24, fontWeight: 800, color: entryCountdown <= 3 ? S.red : S.green }}>{entryCountdown}s</div>}
                        {entryCountdown === 0 && <div style={{ fontSize: 14, fontWeight: 700, color: S.green }}>EXECUTE NOW</div>}
                        <div style={{ fontSize: 9, color: S.muted }}>{entryTimer.instruction}</div>
                      </div>
                    )}
                    <div style={{ fontSize: 72, color: signalColor, lineHeight: 1, marginBottom: 8 }}>{signal.direction === "CALL" ? "↑" : signal.direction === "PUT" ? "↓" : "—"}</div>
                    <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: 8, color: signalColor, marginBottom: 20 }}>{signal.direction}</div>
                    {signal.direction !== "NO TRADE" && (
                      <>
                        <div style={{ display: "flex", justifyContent: "center", gap: 36, marginBottom: 24 }}>
                          <div><div style={{ fontSize: 26, fontWeight: 700, color: signalColor }}>{signal.confidence}%</div><div style={{ fontSize: 9, color: S.muted }}>CONFIDENCE</div></div>
                          <div style={{ width: 1, background: S.border }} />
                          <div><div style={{ fontSize: 26, fontWeight: 700, color: S.green }}>+${(tradeAmount * PAYOUT).toFixed(2)}</div><div style={{ fontSize: 9, color: S.muted }}>IF WIN</div></div>
                        </div>
                        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                          <button onClick={() => handleResult("WIN")} style={{ padding: "12px 32px", background: S.greenFaint, border: `1px solid ${S.green}`, color: S.green, borderRadius: 8, cursor: "pointer", fontWeight: 700 }}>WIN +{(PAYOUT * 100).toFixed(0)}%</button>
                          <button onClick={() => handleResult("LOSS")} style={{ padding: "12px 32px", background: S.redFaint, border: `1px solid ${S.red}`, color: S.red, borderRadius: 8, cursor: "pointer", fontWeight: 700 }}>LOSS -100%</button>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: S.dim, letterSpacing: 4, padding: "40px 0" }}>{killSwitch ? "KILL SWITCH ACTIVE" : "START SESSION TO SCAN"}</div>
                )}
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button onClick={killSwitch ? null : (scanning ? stopScanner : () => setShowSetup(true))} style={{ flex: 2, padding: 14, background: killSwitch ? S.dim : scanning ? S.red : S.green, border: "none", color: killSwitch ? S.muted : "#000", fontWeight: 700, borderRadius: 10, cursor: "pointer" }}>
                  {killSwitch ? "KILL SWITCH" : scanning ? "STOP" : "START SESSION"}
                </button>
                <button onClick={runFullScan} disabled={loading || killSwitch} style={{ flex: 1, padding: 14, background: "transparent", border: `1px solid ${S.border}`, color: loading || killSwitch ? S.dim : S.muted, borderRadius: 10, cursor: "pointer" }}>
                  SCAN
                </button>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 9, color: S.muted, letterSpacing: 3, marginBottom: 12 }}>ANALYSIS</div>
              {signal?.indicators?.length > 0 ? signal.indicators.map(ind => {
                const color = ind.vote === "CALL" ? S.green : ind.vote === "PUT" ? S.red : S.dim
                return (
                  <div key={ind.name} style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 10, padding: "12px 16px", marginBottom: 10 }}>
                    <div style={{ fontSize: 9, color: S.muted, marginBottom: 4 }}>{ind.name}</div>
                    <div style={{ fontSize: 11, color, fontWeight: 700 }}>{ind.vote === "CALL" ? "↑ CALL" : ind.vote === "PUT" ? "↓ PUT" : "— NEUTRAL"}</div>
                    <div style={{ fontSize: 9, color: S.muted, marginTop: 2 }}>{ind.detail}</div>
                  </div>
                )
              }) : (
                <div style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 10, padding: 24, textAlign: "center", color: S.dim, fontSize: 10 }}>Start scan</div>
              )}
              
              <div style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
                <div style={{ fontSize: 9, color: S.muted, marginBottom: 10 }}>IQ OPTION</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 11, color: iqConnected ? S.green : S.red }}>
                      {iqConnected ? "CONNECTED (DEMO)" : "NOT CONNECTED"}
                    </div>
                    {iqConnected && iqBalance && (
                      <div style={{ fontSize: 9, color: S.muted, marginTop: 3 }}>
                        ${Number(iqBalance).toFixed(2)}
                      </div>
                    )}
                  </div>
                  {iqConnected && (
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: autoTrade ? S.green : S.muted, cursor: "pointer" }}>
                      <input type="checkbox" checked={autoTrade} onChange={e => setAutoTrade(e.target.checked)} />
                      AUTO
                    </label>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "pairs" && (
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            <div style={{ fontSize: 9, color: S.muted, letterSpacing: 3, marginBottom: 16 }}>ALL 18 PAIRS</div>
            {scanResults.length === 0 ? (
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, padding: 40, textAlign: "center", color: S.dim }}>No scan data</div>
            ) : (
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 70px 60px 100px", padding: "10px 20px", borderBottom: `1px solid ${S.border}`, fontSize: 9, color: S.muted }}>
                  <span>PAIR</span><span>CONF</span><span>GRADE</span><span>EXP</span><span style={{ textAlign: "right" }}>SIGNAL</span>
                </div>
                {scanResults.sort((a, b) => b.confidence - a.confidence).map((r, i) => (
                  <div key={r.pair} style={{ display: "grid", gridTemplateColumns: "1fr 70px 70px 60px 100px", padding: "12px 20px", borderBottom: i < scanResults.length - 1 ? `1px solid ${S.border}` : "none" }}>
                    <div><div style={{ fontSize: 12, fontWeight: 600 }}>{r.pair}</div><div style={{ fontSize: 9, color: S.muted }}>{r.engine || "—"}</div></div>
                    <div>{r.confidence}%</div>
                    <div style={{ color: gradeColor(r.grade), fontWeight: 600 }}>{r.grade}</div>
                    <div style={{ fontSize: 10, color: S.muted }}>{r.autoExpiry}</div>
                    <div style={{ textAlign: "right", fontWeight: 700, color: r.direction === "CALL" ? S.green : r.direction === "PUT" ? S.red : S.dim }}>{r.direction === "CALL" ? "↑" : r.direction === "PUT" ? "↓" : "—"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "validate" && (
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <div style={{ fontSize: 9, color: S.muted, letterSpacing: 3, marginBottom: 16 }}>VALIDATE SIGNAL</div>
            <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, padding: 20, marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: S.muted, marginBottom: 10 }}>PAIR</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {SCAN_PAIRS.map(p => <button key={p} onClick={() => setManualPair(p)} style={{ padding: "5px 10px", background: manualPair === p ? S.green + "22" : "transparent", border: `1px solid ${manualPair === p ? S.green : S.border}`, color: manualPair === p ? S.green : S.muted, borderRadius: 6, cursor: "pointer" }}>{p}</button>)}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 9, color: S.muted, marginBottom: 10 }}>ENTRY TIME</div>
                <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)} style={{ width: "100%", padding: "10px 12px", background: S.surface, border: `1px solid ${S.border}`, color: S.text, borderRadius: 8 }} />
              </div>
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 9, color: S.muted, marginBottom: 10 }}>DIRECTION</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {["CALL", "PUT"].map(d => <button key={d} onClick={() => setManualDir(d)} style={{ flex: 1, padding: "10px 0", background: manualDir === d ? (d === "CALL" ? S.green : S.red) : "transparent", border: `1px solid ${d === "CALL" ? S.green : S.red}`, color: manualDir === d ? "#000" : (d === "CALL" ? S.green : S.red), borderRadius: 8, cursor: "pointer", fontWeight: 700 }}>{d === "CALL" ? "↑ CALL" : "↓ PUT"}</button>)}
                </div>
              </div>
            </div>
            {manualResult && (
              <div style={{ background: S.card, border: `1px solid ${manualResult.color}44`, borderRadius: 12, padding: 20, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: manualResult.color }}>{manualResult.verdict}</div>
                  <div style={{ fontSize: 10, color: gradeColor(manualResult.grade), padding: "2px 10px", border: `1px solid ${gradeColor(manualResult.grade)}44`, borderRadius: 4 }}>{manualResult.grade} · {manualResult.confidence}%</div>
                </div>
                {manualResult.entryTiming && (
                  <div style={{ marginBottom: 16, padding: "10px 16px", background: S.surface, borderRadius: 10, border: `1px solid ${S.green}44` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: S.green, marginBottom: 4 }}>ENTRY TIMING</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: S.green }}>{manualResult.entryTiming.message}</div>
                    <div style={{ fontSize: 9, color: S.muted, marginTop: 6 }}>{manualResult.entryTiming.instruction}</div>
                  </div>
                )}
                <div style={{ marginBottom: 16, padding: 12, background: S.surface, borderRadius: 8, fontSize: 11, color: S.muted }}>{manualResult.suggestion}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {manualResult.indicators.map((ind, i) => {
                    const agrees = ind.vote === manualDir
                    return <div key={ind.name} style={{ gridColumn: i === 4 ? "1 / -1" : "auto", background: S.surface, border: `1px solid ${S.border}`, borderRadius: 8, padding: 10 }}>
                      <div style={{ fontSize: 9, color: S.muted, marginBottom: 4 }}>{ind.name}</div>
                      <div style={{ fontSize: 10, color: agrees ? S.green : ind.vote === "NEUTRAL" ? S.dim : S.red, fontWeight: 700 }}>{agrees ? "+ AGREES" : ind.vote === "NEUTRAL" ? "— NEUTRAL" : "- DISAGREES"}</div>
                    </div>
                  })}
                </div>
              </div>
            )}
            <button onClick={handleManualValidate} disabled={manualLoading} style={{ width: "100%", padding: 14, background: manualLoading ? S.surface : S.text, border: `1px solid ${S.border}`, color: manualLoading ? S.dim : "#000", borderRadius: 10, cursor: "pointer", fontWeight: 700 }}>{manualLoading ? "VALIDATING..." : "VALIDATE"}</button>
          </div>
        )}

        {tab === "history" && (
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontSize: 9, color: S.muted }}>TRADE HISTORY</span>
              <span style={{ fontSize: 11, color: winRate >= 56 ? S.green : winRate >= 50 ? S.yellow : S.red }}>{winRate}% WIN RATE</span>
            </div>
            {tradeHistory.length === 0 ? (
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, padding: 40, textAlign: "center", color: S.dim }}>No trades yet</div>
            ) : (
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 80px 100px", padding: "10px 20px", borderBottom: `1px solid ${S.border}`, fontSize: 9, color: S.muted }}>
                  <span>PAIR</span><span>EXP</span><span>CONF</span><span>TIME</span><span style={{ textAlign: "right" }}>RESULT</span>
                </div>
                {tradeHistory.map((t, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 80px 100px", padding: "12px 20px", borderBottom: i < tradeHistory.length - 1 ? `1px solid ${S.border}` : "none" }}>
                    <div><span style={{ color: t.direction === "CALL" ? S.green : S.red }}>{t.direction === "CALL" ? "↑" : "↓"}</span> {t.pair}</div>
                    <div style={{ fontSize: 10, color: S.muted }}>{t.expiry}</div>
                    <div style={{ fontSize: 10, color: S.muted }}>{t.confidence}%</div>
                    <div style={{ fontSize: 10, color: S.muted }}>{t.time}</div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: t.result === "WIN" ? S.green : S.red, fontWeight: 700 }}>
                        {t.result === "WIN" ? `+${(PAYOUT * 100).toFixed(0)}%` : "-100%"}
                      </div>
                      {t.pnl != null && (
                        <div style={{ fontSize: 9, color: t.result === "WIN" ? S.green : S.red }}>
                          {t.pnl >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}