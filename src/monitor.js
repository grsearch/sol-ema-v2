// src/monitor.js — Core monitoring engine (Singleton)
//
// 买入策略：收录即买
//   webhook 收到代币 → 查 FDV → FDV ≥ $20,000 → 立即用 0.5 SOL 买入
//
// 出场策略（EMA 只用于出场）：
//   1. 硬止损    -25%
//   2. 移动止损  峰值回撤 -30%（盈利 100%+ 后激活）
//   3. 分批止盈  TP1/TP2/TP3
//   4. EMA死叉   EMA9 < EMA20 且 EMA20 斜率向下，连续 2 根 5min K线确认
//   5. FDV跌破   $20,000 强制清仓
//   6. 监控到期  4小时后清仓退出

'use strict';

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./ema');
const trader                           = require('./trader');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '60');
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '300');
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '240');
const FDV_MIN_USD        = parseInt(process.env.FDV_MIN_USD           || '20000');
const MAX_TICKS_HISTORY  = 60 * 60 * 3;  // 3h of 1-min ticks = 180 ticks max

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens     = new Map();   // Map<address, TokenState>
    this.tradeLog   = [];          // last 200 trade entries
    this._pollTimer  = null;
    this._klineTimer = null;
    this._metaTimer  = null;
    this._ageTimer   = null;
    this._dashTimer  = null;
  }

  // ── Add token to whitelist ──────────────────────────────────
  async addToken({ address, symbol, network = 'solana' }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already in whitelist: ${symbol} (${address.slice(0, 8)})`);
      return { ok: false, reason: 'already_exists' };
    }

    const state = {
      address,
      symbol:       symbol || address.slice(0, 8),
      network,
      addedAt:      Date.now(),
      ticks:        [],
      candles:      [],
      currentPrice: null,
      ema9:         NaN,
      ema20:        NaN,
      lastSignal:   null,
      fdv:          null,
      lp:           null,
      age:          null,
      // Position tracking (null = no open position)
      position:     null,
      pnlPct:       null,
      // EMA state（仅用于出场判断）
      bearishCount: 0,
      // Lifecycle flags
      bought:       false,   // FDV通过且已下单买入
      exitSent:     false,
      inPosition:   false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address})`);

    await this._fetchMetaAndBuy(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── Meta fetch + FDV gate + 立即买入 ────────────────────────
  async _fetchMetaAndBuy(state) {
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (overview) {
        state.fdv    = overview.fdv ?? overview.mc ?? null;
        state.lp     = overview.liquidity ?? null;
        state.symbol = overview.symbol || state.symbol;
        const created = overview.createdAt || overview.created_at || null;
        if (created) {
          state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
        }
      }
    } catch (e) {
      logger.warn(`[Monitor] meta fetch error ${state.symbol}: ${e.message}`);
    }

    // FDV 门槛检查
    if (state.fdv === null || state.fdv < FDV_MIN_USD) {
      const reason = state.fdv === null
        ? 'FDV_UNKNOWN'
        : `FDV_TOO_LOW($${state.fdv}<$${FDV_MIN_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    // FDV 合格 → 立即买入
    logger.warn(`[Monitor] ✅ ${state.symbol} FDV=$${state.fdv?.toLocaleString()} — 立即买入`);
    const pos = await trader.buy(state);
    if (pos) {
      state.position   = pos;
      state.inPosition = true;
      state.bought     = true;
      state.lastSignal = 'BUY';
      this._addTradeLog({ type: 'BUY', symbol: state.symbol, reason: 'WHITELIST_IMMEDIATE' });
    } else {
      // 买入失败（Jupiter 错误等）→ 不监控，移除
      logger.warn(`[Monitor] ⚠️  ${state.symbol} 买入失败，移除白名单`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, 'BUY_FAILED'), 1000);
    }
  }

  // ── Meta refresh every 30s: check FDV drop ───────────────────
  async _fetchMeta(state) {
    if (state.exitSent) return;
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (!overview) return;

      state.fdv    = overview.fdv ?? overview.mc ?? null;
      state.lp     = overview.liquidity ?? null;
      state.symbol = overview.symbol || state.symbol;
      const created = overview.createdAt || overview.created_at || null;
      if (created) {
        state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
      }

      // FDV dropped below minimum while in position → forced exit
      if (state.inPosition && state.fdv !== null && state.fdv < FDV_MIN_USD) {
        logger.warn(`[Monitor] ⚠️  FDV dropped: ${state.symbol} FDV=$${state.fdv} — exiting`);
        await this._doExit(state, `FDV_DROPPED($${state.fdv}<$${FDV_MIN_USD})`);
      }
    } catch (e) {
      logger.warn(`[Monitor] meta refresh error ${state.symbol}: ${e.message}`);
    }
  }

  // ── Start all timers ──────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s` +
      ` | FDV_MIN $${FDV_MIN_USD} | max_age ${TOKEN_MAX_AGE_MIN}min`
    );
    this._pollTimer  = setInterval(() => this._pollPrices(),  PRICE_POLL_SEC * 1000);
    this._klineTimer = setInterval(() => this._evaluateAll(), KLINE_INTERVAL_SEC * 1000);
    this._metaTimer  = setInterval(async () => {
      for (const s of this.tokens.values()) {
        await this._fetchMeta(s);
        await sleep(100);
      }
    }, 30_000);
    this._ageTimer  = setInterval(() => this._checkAgeExpiry(), 15_000);
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 5000);
  }

  stop() {
    [this._pollTimer, this._klineTimer, this._metaTimer, this._ageTimer, this._dashTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── Price poll every PRICE_POLL_SEC (60s) ───────────────────
  async _pollPrices() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.bought) continue;
      const price = await birdeye.getPrice(addr);
      if (price !== null && price > 0) {
        state.currentPrice = price;
        state.ticks.push({ time: Date.now(), price });
        if (state.ticks.length > MAX_TICKS_HISTORY) {
          state.ticks.splice(0, state.ticks.length - MAX_TICKS_HISTORY);
        }
        // Update live PnL
        if (state.position && state.position.entryPrice) {
          state.pnlPct = (
            (price - state.position.entryPrice) / state.position.entryPrice * 100
          ).toFixed(2);
        }
      }
      await sleep(200);  // stagger requests
    }
  }

  // ── EMA评估 every KLINE_INTERVAL_SEC (5 min) ────────────────
  // 只负责出场：止盈/止损/移动止损/EMA死叉
  async _evaluateAll() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.bought || !state.ticks.length) continue;

      // 构建K线，排除最后一根（未收盘）
      state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);
      const closedCandles = state.candles.length > 1
        ? state.candles.slice(0, -1)
        : state.candles;

      // ── 持仓中：检查止盈/止损/移动止损 ─────────────────────
      if (state.inPosition && state.position) {
        const action = await trader.managePosition(state);
        if (action === 'EXIT') {
          state.inPosition = false;
          state.position   = null;
          this._addTradeLog({ type: 'EXIT', symbol: state.symbol, reason: 'stop_or_trail' });
          // 止损/移动止损触发后直接退出监控
          state.exitSent = true;
          setTimeout(() => this._removeToken(addr, 'STOP_OR_TRAIL'), 5000);
          continue;
        } else if (action === 'PARTIAL') {
          this._addTradeLog({ type: 'PARTIAL_SELL', symbol: state.symbol });
        }
      }

      // ── EMA死叉检查（仅出场，不再买入）─────────────────────
      const result = evaluateSignal(closedCandles, state);
      state.ema9   = result.ema9;
      state.ema20  = result.ema20;

      if (result.signal === 'SELL' && state.inPosition) {
        logger.warn(`[Strategy] EMA死叉 SELL ${state.symbol} — ${result.reason}`);
        await this._doExit(state, result.reason);
      }
    }
  }

  // ── Full exit helper ──────────────────────────────────────────
  async _doExit(state, reason) {
    await trader.exitPosition(state, reason);
    state.inPosition = false;
    state.position   = null;
    state.lastSignal = 'SELL';
    state.exitSent   = true;
    this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason });
    setTimeout(() => this._removeToken(state.address, reason), 5000);
  }

  // ── Age expiry check every 15s ────────────────────────────────
  async _checkAgeExpiry() {
    const maxMin = TOKEN_MAX_AGE_MIN;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      const ageMin = state.age !== null
        ? parseFloat(state.age)
        : (Date.now() - state.addedAt) / 60000;

      if (ageMin < maxMin) continue;

      state.exitSent = true;

      if (state.inPosition && state.position) {
        logger.info(`[Monitor] ⏰ Age expiry SELL: ${state.symbol} (${ageMin.toFixed(1)}min)`);
        await trader.exitPosition(state, `AGE_EXPIRY_${maxMin}min`);
        state.inPosition = false;
        state.position   = null;
        this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason: 'AGE_EXPIRY' });
        setTimeout(() => this._removeToken(addr, 'AGE_EXPIRY'), 5000);
      } else {
        logger.info(`[Monitor] ⏰ Age expiry (no position): ${state.symbol}`);
        this._removeToken(addr, 'AGE_EXPIRY_NO_POSITION');
      }
    }
  }

  _removeToken(addr, reason) {
    const state = this.tokens.get(addr);
    if (state) {
      logger.info(`[Monitor] 🗑  Removed ${state.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  _addTradeLog(entry) {
    const log = { id: Date.now(), time: new Date().toISOString(), ...entry };
    this.tradeLog.unshift(log);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;
    broadcastToClients({ type: 'trade_log', data: log });
  }

  _stateView(s) {
    const pos = s.position;
    return {
      address:       s.address,
      symbol:        s.symbol,
      age:           s.age,
      lp:            s.lp,
      fdv:           s.fdv,
      currentPrice:  s.currentPrice,
      entryPrice:    pos?.entryPrice   ?? null,
      peakPrice:     pos?.peakPrice    ?? null,
      tokenBalance:  pos?.tokenBalance ?? 0,
      tpHit:         pos?.tpHit        ?? [],
      pnlPct:        s.pnlPct,
      ema9:          isNaN(s.ema9)  ? null : +s.ema9.toFixed(10),
      ema20:         isNaN(s.ema20) ? null : +s.ema20.toFixed(10),
      lastSignal:    s.lastSignal,
      candleCount:   s.candles.length,
      tickCount:     s.ticks.length,
      addedAt:       s.addedAt,
      bought:        s.bought,
      exitSent:      s.exitSent,
      inPosition:    s.inPosition,
      recentCandles: s.candles.slice(-60),
    };
  }

  getDashboardData() {
    return {
      tokens:     [...this.tokens.values()].map(s => this._stateView(s)),
      tradeLog:   this.tradeLog.slice(0, 100),
      uptime:     process.uptime(),
      tokenCount: this.tokens.size,
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TokenMonitor };
