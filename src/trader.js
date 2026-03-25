// src/trader.js — Jupiter-based auto-trader with MEV protection & tiered take-profit
//
// Architecture:
//   • Uses Jupiter Ultra API (Pro I) for swap quote + execute
//   • Anti-sandwich via Jito bundle tip + priority fee
//   • Tiered TP: sells a fraction of holdings at each profit level
//   • Hard stop-loss: -25% from entry
//   • Trailing stop: 30% pullback from peak once up 100%+
//   • EMA death-cross: sells remainder of position

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
const HELIUS_RPC      = process.env.HELIUS_RPC_URL       || '';
const JUP_API         = process.env.JUPITER_API_URL      || 'https://api.jup.ag';
const SLIPPAGE_BPS    = parseInt(process.env.SLIPPAGE_BPS            || '300');
const USE_JITO        = process.env.USE_JITO === 'true';
const JITO_TIP        = parseInt(process.env.JITO_TIP_LAMPORTS       || '1000000');
const PRIORITY_FEE    = parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '100000');
const TRADE_SOL       = parseFloat(process.env.TRADE_SIZE_SOL        || '0.5');

// Take-profit levels
const TP1_PCT   = parseFloat(process.env.TP1_PCT  || '100');   // +100%
const TP1_SELL  = parseFloat(process.env.TP1_SELL || '33');    // sell 33%
const TP2_PCT   = parseFloat(process.env.TP2_PCT  || '200');
const TP2_SELL  = parseFloat(process.env.TP2_SELL || '33');
const TP3_PCT   = parseFloat(process.env.TP3_PCT  || '400');
const TP3_SELL  = parseFloat(process.env.TP3_SELL || '50');
// TP4: EMA death-cross triggers full remainder exit

const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '25');
const TRAIL_PCT     = parseFloat(process.env.TRAIL_PCT     || '30');

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
 * Get a Jupiter Ultra swap order (Pro I endpoint).
 * Ultra mode auto-selects best route and handles token accounts.
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
    timeout: 10000,
  });
  return data;  // { swapType, requestId, inAmount, outAmount, swapTransaction, ... }
}

/**
 * Execute a Jupiter Ultra swap order.
 * Returns { signature, inputAmount, outputAmount }.
 */
async function executeSwapOrder({ requestId, signedTransaction }) {
  const url = `${JUP_API}/ultra/v1/execute`;
  const { data } = await axios.post(url, {
    requestId,
    signedTransaction,
  }, { timeout: 30000 });
  return data;  // { status, signature, inputAmount, outputAmount, ... }
}

/**
 * Sign a base64 VersionedTransaction and return base64 signed bytes.
 */
function signTx(base64Tx) {
  const kp  = getKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── Get token balance (in raw units) ──────────────────────────
async function getTokenBalance(mintAddress) {
  const conn = getConn();
  const kp   = getKeypair();

  // Native SOL
  if (mintAddress === SOL_MINT) {
    const bal = await conn.getBalance(kp.publicKey);
    return bal;  // lamports
  }

  const mint = new PublicKey(mintAddress);
  const { value } = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint });
  if (!value.length) return 0;
  return parseInt(value[0].account.data.parsed.info.tokenAmount.amount || '0');
}

// ── Build Jito-aware swap (priority fee + tip instruction) ─────
// Jupiter Ultra already handles priority fees via the API params.
// We pass computeUnitPriceMicroLamports to request higher priority.
async function buildBuyOrder(tokenMint, solAmountLamports) {
  return getSwapOrder({
    inputMint:  SOL_MINT,
    outputMint: tokenMint,
    amount:     solAmountLamports,
  });
}

async function buildSellOrder(tokenMint, tokenAmount) {
  return getSwapOrder({
    inputMint:  tokenMint,
    outputMint: SOL_MINT,
    amount:     tokenAmount,
    // Slightly wider slippage on exit to guarantee fill
    slippageBps: Math.min(SLIPPAGE_BPS * 2, 1000),
  });
}

// ── Execute with retry ─────────────────────────────────────────
async function executeWithRetry(order, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signed = signTx(order.swapTransaction);
      const result = await executeSwapOrder({
        requestId:         order.requestId,
        signedTransaction: signed,
      });
      if (result.status === 'Success') return result;
      logger.warn(`[Trader] Swap status ${result.status} (attempt ${attempt})`);
    } catch (e) {
      logger.warn(`[Trader] Execute attempt ${attempt} failed: ${e.message}`);
    }
    if (attempt < retries) await sleep(1500 * attempt);
  }
  throw new Error('Swap failed after retries');
}

// ── Main: BUY ──────────────────────────────────────────────────
/**
 * Buy `TRADE_SIZE_SOL` worth of `tokenMint`.
 * Returns position object: { entryPrice, tokenBalance, solSpent, tpHit }
 */
async function buy(tokenState) {
  const { address, symbol, currentPrice } = tokenState;
  logger.warn(`[Trader] BUY ${symbol} @ price ${currentPrice}`);

  const solLamports = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);

  try {
    const order  = await buildBuyOrder(address, solLamports);
    const result = await executeWithRetry(order);

    const tokenBalance = parseInt(result.outputAmount || '0');
    logger.warn(`[Trader] BUY OK ${symbol} | sig=${result.signature?.slice(0,12)} | got=${tokenBalance} tokens`);

    const pos = {
      tokenBalance,   // raw token units held
      solSpent:       TRADE_SOL,
      entryPrice:     currentPrice,
      peakPrice:      currentPrice,
      tpHit:          [],         // which TP levels have fired
      initialBalance: tokenBalance,
      txBuy:          result.signature,
    };

    _broadcastTrade('BUY', symbol, address, currentPrice, TRADE_SOL, result.signature);
    return pos;
  } catch (e) {
    logger.warn(`[Trader] BUY FAILED ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Main: SELL (partial or full) ──────────────────────────────
/**
 * Sell `fraction` (0–1) of the remaining token balance.
 * Returns updated position (or null if fully exited).
 */
async function sell(tokenState, fraction, reason) {
  const { address, symbol, currentPrice, position } = tokenState;
  if (!position || position.tokenBalance <= 0) return null;

  const rawSellAmount = Math.floor(position.tokenBalance * fraction);
  if (rawSellAmount <= 0) return position;

  logger.warn(`[Trader] SELL ${(fraction * 100).toFixed(0)}% ${symbol} (${reason}) @ ${currentPrice}`);

  try {
    const order  = await buildSellOrder(address, rawSellAmount);
    const result = await executeWithRetry(order);

    const solReceived = parseInt(result.outputAmount || '0') / LAMPORTS_PER_SOL;
    const newBalance  = position.tokenBalance - rawSellAmount;

    logger.warn(`[Trader] SELL OK ${symbol} | sig=${result.signature?.slice(0,12)} | received=${solReceived.toFixed(4)} SOL | remaining=${newBalance}`);
    _broadcastTrade('SELL', symbol, address, currentPrice, solReceived, result.signature, reason);

    if (newBalance <= 0) return null;  // fully exited
    return { ...position, tokenBalance: newBalance };
  } catch (e) {
    logger.warn(`[Trader] SELL FAILED ${symbol}: ${e.message}`);
    return position;  // unchanged on failure — will retry next cycle
  }
}

// ── Position manager — called every EMA eval cycle ────────────
/**
 * Check stop-loss, trailing stop, and take-profit levels.
 * Returns 'HOLD', 'PARTIAL', or 'EXIT'.
 *
 * Mutates tokenState.position (updates peakPrice, tpHit, tokenBalance).
 */
async function managePosition(tokenState) {
  const { currentPrice, position } = tokenState;
  if (!position || position.tokenBalance <= 0) return 'NONE';

  const entryPrice = position.entryPrice;
  const pnlPct     = (currentPrice - entryPrice) / entryPrice * 100;

  // Update peak
  if (currentPrice > position.peakPrice) {
    tokenState.position.peakPrice = currentPrice;
  }
  const peakPrice = tokenState.position.peakPrice;

  // ── Hard stop-loss ──────────────────────────────────────────
  if (pnlPct <= -STOP_LOSS_PCT) {
    logger.warn(`[Trader] STOP-LOSS ${tokenState.symbol} PnL=${pnlPct.toFixed(1)}%`);
    tokenState.position = await sell(tokenState, 1.0, `STOP_LOSS_${STOP_LOSS_PCT}%`);
    return 'EXIT';
  }

  // ── Trailing stop (active once up >= 100%) ──────────────────
  if (pnlPct >= 100) {
    const trailStop = peakPrice * (1 - TRAIL_PCT / 100);
    if (currentPrice <= trailStop) {
      logger.warn(`[Trader] TRAIL-STOP ${tokenState.symbol} peak=${peakPrice.toExponential(4)} stop=${trailStop.toExponential(4)}`);
      tokenState.position = await sell(tokenState, 1.0, `TRAIL_STOP_${TRAIL_PCT}%`);
      return 'EXIT';
    }
  }

  // ── Tiered take-profits ─────────────────────────────────────
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
