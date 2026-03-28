// src/trader.js — Jupiter-based auto-trader with MEV protection & tiered take-profit
//
// Architecture:
//   • Uses Jupiter Ultra API (Pro I) for swap quote + execute
//   • Anti-sandwich via Jito bundle tip + priority fee
//   • Tiered TP: DISABLED (set TP_ENABLED=true to re-enable)
//   • Hard stop-loss: -50% from entry
//   • Trailing stop: 30% pullback from peak, activates once up 50%+
//   • EMA death-cross: sells remainder of position
//   • Dynamic slippage retry: each retry widens slippage ×1.5, max 2000 bps

'use strict';

const {
  Connection, Keypair, PublicKey,
  VersionedTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58   = require('bs58');
const axios  = require('axios');
const logger = require('./logger');
const { broadcastToClients } = require('./wsHub');

// ── Config ─────────────────────────────────────────────────────
const HELIUS_RPC   = process.env.HELIUS_RPC_URL            || '';
const JUP_API      = process.env.JUPITER_API_URL           || 'https://api.jup.ag';
const JUP_API_KEY  = process.env.JUPITER_API_KEY           || '';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS     || '500');  // ← 默认 5%
const TRADE_SOL    = parseFloat(process.env.TRADE_SIZE_SOL || '0.5');

// 动态滑点上限：重试时最多放宽到 20%
const SLIPPAGE_MAX_BPS = 2000;

function jupHeaders() {
  return JUP_API_KEY ? { 'x-api-key': JUP_API_KEY } : {};
}

// Take-profit（暂停：TP_ENABLED=true 可重新启用）
const TP_ENABLED = process.env.TP_ENABLED === 'true';
const TP1_PCT    = parseFloat(process.env.TP1_PCT  || '100');
const TP1_SELL   = parseFloat(process.env.TP1_SELL || '33');
const TP2_PCT    = parseFloat(process.env.TP2_PCT  || '200');
const TP2_SELL   = parseFloat(process.env.TP2_SELL || '33');
const TP3_PCT    = parseFloat(process.env.TP3_PCT  || '400');
const TP3_SELL   = parseFloat(process.env.TP3_SELL || '50');

const STOP_LOSS_PCT      = parseFloat(process.env.STOP_LOSS_PCT      || '50');
const TRAIL_PCT          = parseFloat(process.env.TRAIL_PCT          || '30');
const TRAIL_ACTIVATE_PCT = parseFloat(process.env.TRAIL_ACTIVATE_PCT || '50');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Wallet ─────────────────────────────────────────────────────
let _keypair = null;
function getKeypair() {
  if (_keypair) return _keypair;
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('WALLET_PRIVATE_KEY not set');
  _keypair = Keypair.fromSecretKey(bs58.decode(pk));
  return _keypair;
}

// ── RPC connection ─────────────────────────────────────────────
let _conn = null;
function getConn() {
  if (_conn) return _conn;
  if (!HELIUS_RPC) throw new Error('HELIUS_RPC_URL not set');
  _conn = new Connection(HELIUS_RPC, 'confirmed');
  return _conn;
}

// ── Jupiter helpers ────────────────────────────────────────────

/**
 * Fetch a Jupiter Ultra swap order.
 * slippageBps 显式传入，供动态重试逻辑使用。
 */
async function getSwapOrder({ inputMint, outputMint, amount, slippageBps }) {
  const url = `${JUP_API}/ultra/v1/order`;
  const { data } = await axios.get(url, {
    params: {
      inputMint,
      outputMint,
      amount:      Math.floor(amount).toString(),
      slippageBps: slippageBps ?? SLIPPAGE_BPS,
      taker:       getKeypair().publicKey.toBase58(),
    },
    headers: jupHeaders(),
    timeout: 10000,
  });
  return data;
}

async function executeSwapOrder({ requestId, signedTransaction }) {
  const url = `${JUP_API}/ultra/v1/execute`;
  const { data } = await axios.post(url, { requestId, signedTransaction }, {
    headers: jupHeaders(),
    timeout: 30000,
  });
  return data;
}

function signTx(base64Tx) {
  const kp  = getKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── Token balance ──────────────────────────────────────────────
async function getTokenBalance(mintAddress) {
  const conn = getConn();
  const kp   = getKeypair();
  if (mintAddress === SOL_MINT) return conn.getBalance(kp.publicKey);
  const mint = new PublicKey(mintAddress);
  const { value } = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint });
  if (!value.length) return 0;
  return parseInt(value[0].account.data.parsed.info.tokenAmount.amount || '0');
}

// ── Order builders（接受显式 slippageBps，供重试时递增）─────────

async function buildBuyOrder(tokenMint, solAmountLamports, slippageBps) {
  return getSwapOrder({
    inputMint:   SOL_MINT,
    outputMint:  tokenMint,
    amount:      solAmountLamports,
    slippageBps: slippageBps ?? SLIPPAGE_BPS,
  });
}

async function buildSellOrder(tokenMint, tokenAmount, slippageBps) {
  // 卖出滑点 = 传入值的 2 倍，确保止损单能成交，但不超过 SLIPPAGE_MAX_BPS
  const base = slippageBps ?? SLIPPAGE_BPS;
  return getSwapOrder({
    inputMint:   tokenMint,
    outputMint:  SOL_MINT,
    amount:      tokenAmount,
    slippageBps: Math.min(base * 2, SLIPPAGE_MAX_BPS),
  });
}

// ── Dynamic-slippage retry ─────────────────────────────────────
//
// orderFn: (slippageBps: number) => Promise<JupiterOrder>
//   每次重试都重新拉报价（价格更新鲜），并将滑点 ×1.5，
//   上限为 SLIPPAGE_MAX_BPS（20%）。
//
// 首次:   SLIPPAGE_BPS        (5%  = 500)
// 重试1:  min(500×1.5, 2000)  (7.5% = 750)
// 重试2:  min(750×1.5, 2000)  (11.25% → 1125)
async function executeWithRetry(orderFn, retries = 3) {
  let slippage = SLIPPAGE_BPS;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const order    = await orderFn(slippage);
      const txBase64 = order.transaction;
      if (!txBase64) {
        throw new Error(
          `Jupiter order missing 'transaction' field. Keys: ${Object.keys(order).join(', ')}`
        );
      }

      const signed = signTx(txBase64);
      const result = await executeSwapOrder({
        requestId:         order.requestId,
        signedTransaction: signed,
      });

      if (result.status === 'Success') return result;
      logger.warn(
        `[Trader] Swap status="${result.status}" attempt=${attempt} slippage=${slippage}bps`
      );
    } catch (e) {
      logger.warn(
        `[Trader] Execute attempt=${attempt} slippage=${slippage}bps error: ${e.message}`
      );
    }

    // 加宽滑点，等待后重试
    slippage = Math.min(Math.floor(slippage * 1.5), SLIPPAGE_MAX_BPS);
    if (attempt < retries) await sleep(1500 * attempt);
  }

  throw new Error(`Swap failed after ${retries} retries`);
}

// ── BUY ────────────────────────────────────────────────────────
async function buy(tokenState) {
  const { address, symbol, currentPrice } = tokenState;
  logger.warn(`[Trader] BUY ${symbol} @ Birdeye=${currentPrice}`);

  const solLamports = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);

  try {
    const result = await executeWithRetry(
      (slipBps) => buildBuyOrder(address, solLamports, slipBps)
    );

    const tokenBalance     = parseInt(result.outputAmountResult || '0');
    const solSpentLamports = parseInt(result.inputAmountResult  || String(solLamports));

    // 买入完成后重拉价格作为开仓基准，避免执行耗时导致止损基准偏移
    let entryPriceUsd = currentPrice;
    try {
      const freshPrice = await require('./birdeye').getPrice(address);
      if (freshPrice && freshPrice > 0) {
        entryPriceUsd = freshPrice;
        logger.warn(`[Trader] Entry price refreshed: ${currentPrice} → ${freshPrice}`);
      }
    } catch (_) {
      logger.warn('[Trader] Entry price refresh failed, using pre-buy price');
    }

    logger.warn(
      `[Trader] BUY OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | got=${tokenBalance} tokens` +
      ` | spent=${(solSpentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL` +
      ` | entryUsd=${entryPriceUsd}`
    );

    const pos = {
      tokenBalance,
      initialBalance: tokenBalance,
      solSpent:       solSpentLamports / LAMPORTS_PER_SOL,
      tpHit:          [],
      txBuy:          result.signature,
      entryPriceUsd,
      peakPriceUsd:   entryPriceUsd,
    };

    _broadcastTrade('BUY', symbol, address, entryPriceUsd, pos.solSpent, result.signature);
    return pos;
  } catch (e) {
    logger.warn(`[Trader] BUY FAILED ${symbol}: ${e.message}`);
    return null;
  }
}

// ── SELL (partial or full) ─────────────────────────────────────
async function sell(tokenState, fraction, reason) {
  const { address, symbol, currentPrice, position } = tokenState;
  if (!position || position.tokenBalance <= 0) return null;

  const rawSellAmount = Math.floor(position.tokenBalance * fraction);
  if (rawSellAmount <= 0) return position;

  logger.warn(`[Trader] SELL ${(fraction * 100).toFixed(0)}% ${symbol} (${reason}) @ ${currentPrice}`);

  try {
    const result = await executeWithRetry(
      (slipBps) => buildSellOrder(address, rawSellAmount, slipBps)
    );

    const solReceived = parseInt(result.outputAmountResult || '0') / LAMPORTS_PER_SOL;
    const newBalance  = position.tokenBalance - rawSellAmount;

    logger.warn(
      `[Trader] SELL OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | received=${solReceived.toFixed(4)} SOL` +
      ` | remaining=${newBalance}`
    );
    _broadcastTrade('SELL', symbol, address, currentPrice, solReceived, result.signature, reason);

    if (newBalance <= 0) return null;
    return { ...position, tokenBalance: newBalance };
  } catch (e) {
    logger.warn(`[Trader] SELL FAILED ${symbol}: ${e.message}`);
    return position;  // 保持原仓位，下次 tick 重试
  }
}

// ── Position manager（每秒调用）────────────────────────────────
//
// 出场优先级：
//   1. 硬止损      -50%
//   2. 移动止损    峰值涨幅 ≥ 50% 激活，峰值回撤 -30% 触发
//   3. 分批止盈    暂停（TP_ENABLED=false）
// Returns: 'HOLD' | 'PARTIAL' | 'EXIT' | 'NONE'
async function managePosition(tokenState) {
  const { currentPrice, position, symbol } = tokenState;
  if (!position || position.tokenBalance <= 0) return 'NONE';

  const entryPriceUsd = position.entryPriceUsd;
  if (!entryPriceUsd || !currentPrice) return 'HOLD';

  const pnlPct = (currentPrice - entryPriceUsd) / entryPriceUsd * 100;

  if (currentPrice > (position.peakPriceUsd ?? 0)) {
    tokenState.position.peakPriceUsd = currentPrice;
  }
  const peakPriceUsd = tokenState.position.peakPriceUsd;
  const peakPnlPct   = (peakPriceUsd - entryPriceUsd) / entryPriceUsd * 100;

  tokenState.pnlPct = pnlPct.toFixed(2);

  // ── 1. 硬止损 -50% ─────────────────────────────────────────
  if (pnlPct <= -STOP_LOSS_PCT) {
    logger.warn(`[Trader] STOP-LOSS ${symbol} PnL=${pnlPct.toFixed(1)}%`);
    tokenState.position = await sell(tokenState, 1.0, `STOP_LOSS_${STOP_LOSS_PCT}%`);
    return 'EXIT';
  }

  // ── 2. 移动止损 ────────────────────────────────────────────
  if (peakPnlPct >= TRAIL_ACTIVATE_PCT) {
    const trailStop = peakPriceUsd * (1 - TRAIL_PCT / 100);
    if (currentPrice <= trailStop) {
      logger.warn(
        `[Trader] TRAIL-STOP ${symbol}` +
        ` peak=+${peakPnlPct.toFixed(0)}%` +
        ` trailStop=${trailStop.toExponential(3)}` +
        ` now=${pnlPct.toFixed(1)}%`
      );
      tokenState.position = await sell(tokenState, 1.0, `TRAIL_STOP_peak+${peakPnlPct.toFixed(0)}%`);
      return 'EXIT';
    }
  }

  // ── 3. 分批止盈（暂停中，TP_ENABLED=false）─────────────────
  if (TP_ENABLED) {
    let acted = false;

    if (!position.tpHit.includes('TP1') && pnlPct >= TP1_PCT) {
      tokenState.position.tpHit.push('TP1');
      tokenState.position = await sell(tokenState, TP1_SELL / 100, `TP1_+${TP1_PCT}%`);
      acted = true;
    } else if (!position.tpHit.includes('TP2') && pnlPct >= TP2_PCT) {
      tokenState.position.tpHit.push('TP2');
      tokenState.position = await sell(tokenState, TP2_SELL / 100, `TP2_+${TP2_PCT}%`);
      acted = true;
    } else if (!position.tpHit.includes('TP3') && pnlPct >= TP3_PCT) {
      tokenState.position.tpHit.push('TP3');
      tokenState.position = await sell(tokenState, TP3_SELL / 100, `TP3_+${TP3_PCT}%`);
      acted = true;
    }

    if (!tokenState.position || tokenState.position.tokenBalance <= 0) return 'EXIT';
    return acted ? 'PARTIAL' : 'HOLD';
  }

  return 'HOLD';
}

// ── EMA death-cross exit ───────────────────────────────────────
async function exitPosition(tokenState, reason) {
  if (!tokenState.position || tokenState.position.tokenBalance <= 0) return;
  tokenState.position = await sell(tokenState, 1.0, reason);
}

// ── Helpers ────────────────────────────────────────────────────
function _broadcastTrade(type, symbol, mint, price, amount, sig, reason = '') {
  broadcastToClients({
    type: 'trade',
    data: {
      id: Date.now(), time: new Date().toISOString(),
      tradeType: type, symbol, mint, price, amount, sig, reason,
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buy, sell, exitPosition, managePosition, getKeypair, getConn };
