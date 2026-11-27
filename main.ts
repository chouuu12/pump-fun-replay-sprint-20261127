// Paper bot for the make.fun Pump.fun Replay Sprint (agent-fun/replay/v2).
//
// Design, from first principles and from measuring the dev window itself.
// Two entry families were tested offline on the 24 h dev dataset (128k
// events, 1123 mints) and in the kit's faithful replay simulator:
//  - Launch buys (3rd trade) + pyramiding into runners: LOSES (-0.7 to
//    -2.4 SOL). Early coins mostly bleed out, and the 1%-of-reserve order
//    cap keeps entries at dust size while the 5-position cap fills with
//    losers. The offline "mean +25%" for launch buys is an artefact of
//    equal-weighting all 741 launches — with 5 slots you only catch ~50.
//  - Reclaim buys (dip bought back to the high): LOSES badly (-2.5 SOL).
//  - Dip-flip scalps (this bot): roughly breakeven. Buy a coin with 24+
//    trades, 15+ min old, 12% below its 24-trade high but still above its
//    price 24 trades ago, ticking up, buyers present, 3+ SOL real reserves.
//    Flip the whole position at +20%, stop at -6%, 60-trade timeout, and a
//    trailing stop once the peak is +5% and it retraces 15 points. 0.2 SOL
//    per buy. Dev: +0.046 SOL over 59 trips / 37 mints — breakeven-grade and
//    concentrated in 3 coins, i.e. NOT a comfortable pass of the quality
//    gate. The window's real money sits in a handful of 10x runners that no
//    simple rule in this file catches reliably; this entry is an honest
//    breakeven scalper, not a compounding runner-catcher.
// Two mechanics that mattered in testing: (1) sells must be sent whole —
// sliced sells strand positions when the proceeds fall below the tx fees
// (zero_amount) and the dead position then blocks one of the 5 slots for
// the rest of the run; (2) 500 bps slippage on sells is enough, 1500 bps
// buys/sells are not better.
//
// The grader runs `node /bot/main.ts`. Zero dependencies, no clock, no random
// numbers, no environment reads: fully deterministic, so the two grading runs
// agree byte for byte.

import { runBot, LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

export interface BotParams {
  /** Entry style: 'launch' buys the 3rd trade; 'dip' buys a retracement. */
  entryMode: 'launch' | 'dip';
  /** Launch mode: buy when the mint's trade count reaches this. */
  launchTrade: number;
  /** Launch mode: buys among the first trades required. */
  launchMinBuys: number;
  /** Launch mode: skip when the price already fell this far below the first trade. */
  launchMaxDropBps: number;
  /** Dip mode: trades observed before a mint is considered. */
  minTrades: number;
  /** Dip mode: slots a coin must have lived before we buy it. */
  minAgeSlots: number;
  /** Dip mode: how far below the 24-observation high the price must be. */
  dipBps: number;
  /** Dip mode: deepest dip we still buy (share of the high). */
  floorVsHighBps: number;
  /** Dip mode: buys in the last 12 trades required. */
  minBuysLast12: number;
  /** Minimum real SOL reserve to trade a mint. */
  minRealReserveSol: number;
  /** Target size of one buy/add, in SOL. */
  sizeSol: number;
  /** Smallest buy we will bother sending, in SOL. */
  minBuySol: number;
  /** Pyramid: add when the price rises this far above the last add. */
  addStepBps: number;
  /** Pyramid: maximum adds after the entry buy. */
  maxAdds: number;
  /** Pyramid: maximum total cost basis per mint, in SOL. */
  maxCostPerMintSol: number;
  /** Entry bounce (dip mode): price must be at/above the price this many obs ago. */
  bounceObs: number;
  /** Entry uptrend (dip mode): price must exceed the 24-obs-ago price by this. */
  uptrendBps: number;
  /** Take-profit 1: sell this share of the position at this gain. */
  tp1Bps: number;
  tp1ShareBps: number;
  /** Take-profit 2: sell this share of what is left at this gain. */
  tp2Bps: number;
  tp2ShareBps: number;
  /** Stop-loss: sell everything at this loss. */
  slBps: number;
  /** Trailing exit: once the peak gain passes this, sell all on this retrace. */
  trailArmBps: number;
  trailDropBps: number;
  /** Give up after this many observations or slots, whichever comes first. */
  maxHoldObs: number;
  maxHoldSlots: number;
  /** Stale exit: after this many observations with no gain, sell everything. */
  staleObs: number;
  /** Slots to wait before re-buying a mint we just exited. */
  cooldownSlots: number;
}

export const DEFAULT_PARAMS: BotParams = {
  // Best measured dev config (local sim): dip-flip scalper. Entry: a coin
  // with 24+ trades, 15+ min old, 12% below its 24-trade high but above its
  // 24-trade-ago price, ticking up, buyers present, 3+ SOL real reserves.
  // Exit: full flip at +20%, stop at -6%, 60-trade timeout, trailing stop
  // once the peak is +5% and it retraces 15 points. 0.2 SOL per buy.
  // Dev: +0.073 SOL over 47 trips / 29 mints — breakeven-grade, concentrated
  // in 3 coins; NOT a comfortable pass of the quality gate (see README).
  entryMode: 'dip',
  launchTrade: 3,
  launchMinBuys: 2,
  launchMaxDropBps: 2000,
  minTrades: 24,
  minAgeSlots: 900,
  dipBps: 1200,
  floorVsHighBps: 5500,
  minBuysLast12: 5,
  minRealReserveSol: 3,
  sizeSol: 0.2,
  minBuySol: 0.05,
  addStepBps: 5000,
  maxAdds: 0,
  maxCostPerMintSol: 1.5,
  bounceObs: 1,
  uptrendBps: 0,
  tp1Bps: 2000,
  tp1ShareBps: 10000,
  tp2Bps: 30000,
  tp2ShareBps: 2500,
  slBps: 600,
  trailArmBps: 500,
  trailDropBps: 1500,
  maxHoldObs: 60,
  maxHoldSlots: 43200,
  staleObs: 100000,
  cooldownSlots: 600,
};

/** Price as an integer: lamports of SOL per token, scaled by 1e6. Ratios only. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number((vq * 1_000_000n) / vt);
}

interface Tape {
  /** Last <= 48 observed prices, oldest first. */
  prices: number[];
  /** Buy/sell of the last <= 12 trades, oldest first. */
  sides: boolean[];
  createdSlot: number;
  trades: number;
  lastExitSlot: number;
}

interface Entry {
  /** Breakeven price (cost per token incl. fees), refreshed every batch. */
  entryPrice: number;
  entrySlot: number;
  entryObs: number;
  peakPrice: number;
  /** Price at the last buy (entry or latest add): the next add waits for +50%. */
  lastAddPrice: number;
  adds: number;
  tp1Done: boolean;
  tp2Done: boolean;
}

export function createBot(p: BotParams): Bot {
  const tapes = new Map<string, Tape>();
  const entries = new Map<string, Entry>();
  const pendingBuys = new Set<string>();
  const pendingSells = new Map<string, bigint>();

  function tapeFor(mint: string, slot: number): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { prices: [], sides: [], createdSlot: slot, trades: 0, lastExitSlot: -1_000_000 };
      tapes.set(mint, t);
    }
    return t;
  }

  function observe(mint: string, slot: number, vq: bigint, vt: bigint, isBuy: boolean): void {
    const price = priceOf(vq, vt);
    if (price <= 0) return;
    const t = tapeFor(mint, slot);
    t.prices.push(price);
    if (t.prices.length > 48) t.prices.shift();
    t.sides.push(isBuy);
    if (t.sides.length > 12) t.sides.shift();
    t.trades += 1;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const touched = new Set<string>();

    // 1. Fold this batch's trades into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint, e.slot);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        observe(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), e.is_buy);
        touched.add(e.mint);
        const entry = entries.get(e.mint);
        if (entry !== undefined) {
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (price > entry.peakPrice) entry.peakPrice = price;
        }
      } else if (e.event === 'CompleteEvent') {
        entries.delete(e.mint);
        pendingBuys.delete(e.mint);
      }
    }

    // 2. Exits and pyramid adds for every open position.
    for (const [mint, holding] of state.positions) {
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      // Breakeven from the account: cost per token still held (fees included).
      const costPerToken = Number((holding.cost_lamports * 1_000_000n) / holding.token_amount);
      const base = entry ?? {
        entryPrice: costPerToken,
        entrySlot: batch.slot,
        entryObs: tapes.get(mint)?.trades ?? 0,
        peakPrice: price,
        lastAddPrice: price,
        adds: 0,
        tp1Done: false,
        tp2Done: false,
      };
      base.entryPrice = costPerToken;
      if (entry === undefined) entries.set(mint, base);
      if (price > base.peakPrice) base.peakPrice = price;
      const gainBps = Math.floor(((price - base.entryPrice) * 10_000) / base.entryPrice);
      const peakGainBps = Math.floor(((base.peakPrice - base.entryPrice) * 10_000) / base.entryPrice);
      const obsHeld = (tapes.get(mint)?.trades ?? 0) - base.entryObs;
      // Tokens already committed to a sell that has not filled yet: the
      // account still shows them, so never sell them twice.
      const committed = pendingSells.get(mint) ?? 0n;
      const tokens = holding.token_amount - committed;

      let sellTokens = 0n;
      if (tokens > 0n) {
        if (gainBps <= -p.slBps) sellTokens = tokens;
        else if (!base.tp1Done && gainBps >= p.tp1Bps) {
          sellTokens = (tokens * BigInt(p.tp1ShareBps)) / 10_000n;
          base.tp1Done = true;
        } else if (!base.tp2Done && gainBps >= p.tp2Bps) {
          sellTokens = (tokens * BigInt(p.tp2ShareBps)) / 10_000n;
          base.tp2Done = true;
        } else if (peakGainBps >= p.trailArmBps && gainBps <= peakGainBps - p.trailDropBps) {
          sellTokens = tokens;
        } else if (obsHeld >= p.maxHoldObs || batch.slot - base.entrySlot >= p.maxHoldSlots) {
          sellTokens = tokens;
        } else if (obsHeld >= p.staleObs && gainBps < 0) {
          sellTokens = tokens;
        }
      }
      if (sellTokens > 0n) {
        orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 500 });
        pendingSells.set(mint, committed + sellTokens);
        if (committed + sellTokens >= holding.token_amount) {
          entries.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined) t.lastExitSlot = batch.slot;
        }
        continue;
      }

      // Pyramid add: the coin is running and the curve has deepened, so the
      // size cap now allows a real order. Never add into a loser.
      if (
        base.adds < p.maxAdds &&
        gainBps >= 0 &&
        price >= (base.lastAddPrice * (10_000 + p.addStepBps)) / 10_000 &&
        holding.cost_lamports < BigInt(Math.floor(p.maxCostPerMintSol * 1e9)) &&
        !pendingBuys.has(mint) &&
        orders.length < state.hello.caps.max_orders_per_batch
      ) {
        const maxBuy = state.maxBuyLamports(mint);
        let spend = BigInt(Math.floor(p.sizeSol * 1e9));
        if (spend > maxBuy) spend = maxBuy;
        const free = state.freeCashLamports() - state.txFeeLamports();
        if (spend > free) spend = free;
        if (spend >= BigInt(Math.floor(0.01 * 1e9))) {
          orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: 500 });
          pendingBuys.add(mint);
          base.lastAddPrice = price;
          base.adds += 1;
        }
      }
    }

    // 3. Fresh entries: only on mints that traded this batch.
    if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
      for (const mint of touched) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (batch.slot - t.lastExitSlot < p.cooldownSlots) continue;

        let want = false;
        if (p.entryMode === 'launch') {
          // Buy at the Nth trade: early, while the run is still ahead of it.
          if (t.trades === p.launchTrade) {
            let buys = 0;
            for (const s of t.sides) if (s) buys += 1;
            const first = t.prices[0]!;
            const price = t.prices[t.prices.length - 1]!;
            const lastIsBuy = t.sides[t.sides.length - 1] === true;
            if (buys >= p.launchMinBuys && lastIsBuy && price >= (first * (10_000 - p.launchMaxDropBps)) / 10_000) {
              want = true;
            }
          }
        } else {
          const n = t.prices.length;
          if (t.trades >= p.minTrades && n >= p.minTrades && batch.slot - t.createdSlot >= p.minAgeSlots) {
            const price = t.prices[n - 1]!;
            let high = 0;
            let low = Number.POSITIVE_INFINITY;
            const start = Math.max(0, n - 24);
            for (let i = start; i < n; i++) {
              if (t.prices[i]! > high) high = t.prices[i]!;
              if (t.prices[i]! < low) low = t.prices[i]!;
            }
            if (high > 0 && low !== Number.POSITIVE_INFINITY) {
              if (price <= (high * (10_000 - p.dipBps)) / 10_000 && price >= (high * p.floorVsHighBps) / 10_000) {
                const old = t.prices[start]!;
                const ref = t.prices[Math.max(0, n - 1 - p.bounceObs)]!;
                let buys = 0;
                for (const s of t.sides) if (s) buys += 1;
                if (price >= (old * (10_000 + p.uptrendBps)) / 10_000 && price >= ref && buys >= p.minBuysLast12) {
                  want = true;
                }
              }
            }
          }
        }
        if (!want) continue;
        // Liquidity: deep enough real reserve, and the size cap must allow a real buy.
        if (curve.real_quote_reserves < BigInt(p.minRealReserveSol) * LAMPORTS_PER_SOL) continue;
        const maxBuy = state.maxBuyLamports(mint);
        let spend = BigInt(Math.floor(p.sizeSol * 1e9));
        if (spend > maxBuy) spend = maxBuy;
        const free = state.freeCashLamports() - state.txFeeLamports();
        if (spend > free) spend = free;
        if (spend < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
        orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: 500 });
        pendingBuys.add(mint);
      }
    }

    // 4. Fold fills back in: a filled buy becomes a tracked entry; a filled
    // sell releases the tokens it committed.
    for (const f of batch.fills) {
      if (f.side === 'sell' && f.status === 'filled') {
        const committed = pendingSells.get(f.mint) ?? 0n;
        const left = committed - BigInt(f.token_amount);
        if (left <= 0n) pendingSells.delete(f.mint);
        else pendingSells.set(f.mint, left);
      }
      if (f.side === 'sell' && f.status !== 'filled') {
        // A rejected/failed sell frees its tokens; the next batch re-decides.
        pendingSells.delete(f.mint);
      }
      if (f.side === 'buy' && pendingBuys.has(f.mint)) {
        pendingBuys.delete(f.mint);
        if (f.status === 'filled') {
          const curve = state.curves.get(f.mint);
          const tape = tapes.get(f.mint);
          const price = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
          if (price > 0) {
            const prev = entries.get(f.mint);
            entries.set(f.mint, {
              entryPrice: price,
              entrySlot: prev?.entrySlot ?? batch.slot,
              entryObs: prev?.entryObs ?? tape?.trades ?? 0,
              peakPrice: Math.max(price, prev?.peakPrice ?? 0),
              lastAddPrice: price,
              adds: prev?.adds ?? 0,
              tp1Done: prev?.tp1Done ?? false,
              tp2Done: prev?.tp2Done ?? false,
            });
          }
        }
      }
    }

    return orders;
  }

  return { onBatch };
}

export { createBot as createDipBounceBot };

// Only speak the wire protocol when run directly (`node main.ts`); importing
// this file (local backtests) just gets the strategy factory.
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === `file://${entryPath}`) {
  await runBot(createBot(DEFAULT_PARAMS));
}
