// src/ema.js — EMA calculation + SELL signal logic
//
// Candle width: KLINE_INTERVAL_SEC (default 300 = 5 minutes)
// Price poll  : PRICE_POLL_SEC     (default 60 = 1 minute)
//
// BUY  : 收录即买，由 monitor._fetchMetaAndBuy() 直接执行，本模块不处理
// SELL : EMA9 < EMA20 AND EMA20 下行，连续 CONFIRM_BARS 根已收盘K线确认

const EMA_FAST     = parseInt(process.env.EMA_FAST           || '9');
const EMA_SLOW     = parseInt(process.env.EMA_SLOW           || '20');
const CONFIRM_BARS = parseInt(process.env.EMA_CONFIRM_BARS   || '2');
const KLINE_SEC    = parseInt(process.env.KLINE_INTERVAL_SEC || '300');

/**
 * Calculate EMA array for a price series (oldest-first).
 * Seeded with SMA for the first `period` values.
 */
function calcEMA(closes, period) {
  const k      = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  let prev     = null;

  for (let i = 0; i < closes.length; i++) {
    if (prev === null) {
      if (i >= period - 1) {
        prev      = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        result[i] = prev;
      }
    } else {
      prev      = closes[i] * k + prev * (1 - k);
      result[i] = prev;
    }
  }
  return result;
}

/**
 * Evaluate SELL signal from closed candles.
 * BUY is handled upstream (收录即买)，本函数只判断死叉出场。
 *
 * tokenState fields read/mutated: bearishCount
 * Returns: { ema9, ema20, signal: null|'SELL', reason }
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);
  const len    = closes.length;

  if (len < EMA_SLOW + 1) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'warming_up' };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema20_prev = ema20s[len - 2];

  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema20_prev)) {
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  const bearish   = ema9_now < ema20_now;    // EMA9 在 EMA20 下方
  const declining = ema20_now < ema20_prev;  // EMA20 斜率向下

  // SELL 死叉：EMA9 下穿 EMA20 且 EMA20 斜率向下，连续确认
  if (bearish && declining) {
    tokenState.bearishCount = (tokenState.bearishCount || 0) + 1;
  } else {
    tokenState.bearishCount = 0;
  }

  if (tokenState.bearishCount >= CONFIRM_BARS) {
    return {
      ema9: ema9_now, ema20: ema20_now, signal: 'SELL',
      reason: `EMA${EMA_FAST}<EMA${EMA_SLOW} & EMA${EMA_SLOW}↓ ×${tokenState.bearishCount}bars`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Empty buckets are forward-filled from previous close.
 */
function buildCandles(ticks, intervalSec = KLINE_SEC) {
  if (!ticks.length) return [];

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

      let gap = bucketStart + intervalMs;
      while (gap < bucket) {
        const prev = candles[candles.length - 1];
        candles.push({
          time: gap, open: prev.close, high: prev.close,
          low: prev.close, close: prev.close, volume: 0,
        });
        gap += intervalMs;
      }

      bucketStart = bucket;
      current     = null;
    }

    if (!current) {
      current = {
        time: bucket, open: tick.price, high: tick.price,
        low: tick.price, close: tick.price, volume: 1,
      };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.volume++;
    }
  }

  if (current) candles.push(current);
  return candles;
}

module.exports = { calcEMA, evaluateSignal, buildCandles, EMA_FAST, EMA_SLOW };
