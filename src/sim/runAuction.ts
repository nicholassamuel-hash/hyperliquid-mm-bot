/**
 * Paper trader for the AMT auction-reversion strategy on Hyperliquid perp.
 *
 * NO real orders, NO real money. Latency-insensitive: decides on book updates
 * and HOLDS positions for minutes–hours, so it sidesteps the latency wall that
 * made the market-maker negative-EV.
 *
 * Pipeline:  trades → AuctionSignals (VWAP bands, RVOL, delta/CVD)
 *            book   → AuctionReversion (fade failed auctions to value)
 *                   → directional taker fills → Inventory + DB
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../util/logger.js";
import { HyperliquidWS } from "../client/websocket.js";
import { PaperClient } from "../client/hyperliquid.js";
import { AuctionSignals } from "../strategy/auctionSignals.js";
import { AuctionReversion } from "../strategy/auctionReversion.js";
import { detectWalls } from "../strategy/orderbook.js";
import { simulateDirectionalFill } from "./directionalBook.js";
import { Inventory } from "../state/inventory.js";
import { StateDB } from "../state/db.js";
import { writeFileSync } from "node:fs";
import type { MarketContext, OrderbookSnapshot } from "../types.js";

const MARKET_CTX_REFRESH_MS = 60_000;

function obiOf(snap: OrderbookSnapshot, depth = 3): number {
  const bid = snap.bids.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const ask = snap.asks.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const tot = bid + ask;
  return tot > 0 ? (bid - ask) / tot : 0;
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info(
    { coins: cfg.COINS, sizeUsd: cfg.AUCTION_SIZE_USD, bandK: cfg.AUCTION_BAND_K },
    "Auction reversion paper trader starting",
  );
  log.warn("Paper mode: NO real orders, NO real money.");

  const ws = new HyperliquidWS(cfg.COINS, log);
  const rest = new PaperClient({ log });
  const strategy = new AuctionReversion({
    bandK: (cfg.AUCTION_BAND_K === 1 ? 1 : 2) as 1 | 2,
    rvolAcceptMax: cfg.AUCTION_RVOL_ACCEPT_MAX,
    deltaConfirm: cfg.AUCTION_DELTA_CONFIRM,
    obiConfirm: cfg.AUCTION_OBI_CONFIRM,
    stopSigma: cfg.AUCTION_STOP_SIGMA,
    maxHoldMs: cfg.AUCTION_MAX_HOLD_MS,
    cooldownMs: cfg.AUCTION_COOLDOWN_MS,
    rvolFailExit: cfg.AUCTION_RVOL_FAIL_EXIT,
    exitGraceMs: cfg.AUCTION_EXIT_GRACE_MS,
    targetReversion: cfg.AUCTION_TARGET_REVERSION,
    useDivergence: cfg.AUCTION_USE_DIVERGENCE,
    divergenceBars: cfg.AUCTION_DIVERGENCE_BARS,
    useMaker: cfg.AUCTION_USE_MAKER,
    useRegime: cfg.AUCTION_USE_REGIME,
    regimeBars: cfg.AUCTION_REGIME_BARS,
    trendSlopeBps: cfg.AUCTION_TREND_SLOPE_BPS,
    useTrapped: cfg.AUCTION_USE_TRAPPED,
    reclaimBars: cfg.AUCTION_RECLAIM_BARS,
    useWall: cfg.AUCTION_USE_WALL,
    useTrail: cfg.AUCTION_USE_TRAIL,
  });
  const inventory = new Inventory();
  const db = new StateDB("data/auction.db");
  const exitReasons = new Map<string, number>(); // running tally for telemetry

  const signals = new Map<string, AuctionSignals>();
  const lastBook = new Map<string, OrderbookSnapshot>(); // latest book per coin (dashboard)
  const sigFor = (coin: string): AuctionSignals => {
    let s = signals.get(coin);
    if (!s) {
      s = new AuctionSignals(cfg.AUCTION_BAR_MS, cfg.AUCTION_WINDOW_BARS, cfg.AUCTION_WARM_BARS);
      signals.set(coin, s);
    }
    return s;
  };

  // Market context (szDecimals for size rounding, markPrice for MTM)
  const ctxCache = new Map<string, MarketContext>();
  const refreshCtx = async () => {
    for (const coin of cfg.COINS) {
      try {
        const ctx = await rest.getMarketContext(coin);
        if (ctx) ctxCache.set(coin, ctx);
      } catch (err) {
        log.warn({ coin, err: (err as Error).message }, "Ctx refresh failed");
      }
    }
  };
  await refreshCtx();
  setInterval(() => void refreshCtx(), MARKET_CTX_REFRESH_MS);

  // Trades feed the signal layer.
  ws.on("trade", (t) => {
    sigFor(t.coin).pushTrade(t.price, t.size, t.side, t.timestamp);
  });

  // Book updates drive decisions.
  ws.on("book", (snap) => {
    if (snap.bids.length === 0 || snap.asks.length === 0) return;
    lastBook.set(snap.coin, snap);
    const bestBid = snap.bids[0]!.price;
    const bestAsk = snap.asks[0]!.price;
    const mid = (bestBid + bestAsk) / 2;
    const s = sigFor(snap.coin);
    const obi = obiOf(snap);
    const walls = detectWalls(snap);
    const pos = inventory.get(snap.coin);

    const intent = strategy.onUpdate(snap.coin, mid, s, obi, snap.timestamp, walls);
    if (intent.action === "hold") return;

    const ctx = ctxCache.get(snap.coin);
    const fill = simulateDirectionalFill({
      coin: snap.coin,
      intent,
      bestBid,
      bestAsk,
      sizeUsd: cfg.AUCTION_SIZE_USD,
      ts: snap.timestamp,
      position: pos,
      szDecimals: ctx?.szDecimals,
    });

    if (!fill) {
      // Entry that couldn't be sized — revert the optimistic FSM state.
      if (intent.action !== "exit") strategy.abort(snap.coin);
      return;
    }

    const newPos = inventory.apply(fill);
    db.recordFill(fill);
    if (intent.action === "exit") {
      exitReasons.set(intent.reason, (exitReasons.get(intent.reason) ?? 0) + 1);
    }
    log.info(
      {
        coin: snap.coin,
        action: intent.action,
        reason: intent.reason,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        coinSize: newPos.coinSize,
        realized: Number(newPos.realizedPnL.toFixed(6)),
      },
      "AUCTION FILL",
    );
  });

  // Periodic stats — computed from this run's in-memory inventory (clean read).
  const startTs = Date.now();
  setInterval(() => {
    const stats = db.stats(startTs);
    const positions = inventory.all();
    let realized = 0;
    let unreal = 0;
    for (const p of positions) {
      const ctx = ctxCache.get(p.coin);
      const marked = (ctx ? inventory.markToMarket(p.coin, ctx.markPrice) : undefined) ?? p;
      realized += marked.realizedPnL;
      unreal += marked.unrealizedPnL;
    }
    log.info(
      {
        ...stats,
        openPositions: positions.filter((p) => p.coinSize !== 0).length,
        realized: Number(realized.toFixed(4)),
        unrealized: Number(unreal.toFixed(4)),
        net: Number((realized + unreal).toFixed(4)),
        exits: Object.fromEntries(exitReasons),
      },
      "Auction periodic stats",
    );
  }, 30_000);

  // Live snapshot for the local dashboard (data/state.json) — PnL + per-coin signals.
  const writeState = () => {
    const coinsOut: Record<string, unknown> = {};
    for (const coin of cfg.COINS) {
      const sg = signals.get(coin);
      const bk = lastBook.get(coin);
      if (!sg || !bk || bk.bids.length === 0 || bk.asks.length === 0) continue;
      const b = sg.bands();
      const slope = sg.vwapSlopeBps(cfg.AUCTION_REGIME_BARS);
      const w = detectWalls(bk);
      const pos = inventory.get(coin);
      const st = strategy.getState(coin);
      const mid = (bk.bids[0]!.price + bk.asks[0]!.price) / 2;
      coinsOut[coin] = {
        price: mid,
        warm: sg.warm(),
        vwap: b.vwap,
        upper2: b.upper2,
        lower2: b.lower2,
        upper1: b.upper1,
        lower1: b.lower1,
        rvol: Number(sg.rvol().toFixed(2)),
        delta: Number(sg.recentDelta().toFixed(2)),
        cvd: Number(sg.cvd().toFixed(2)),
        slopeBps: Number(slope.toFixed(2)),
        regime:
          slope > cfg.AUCTION_TREND_SLOPE_BPS ? "up" : slope < -cfg.AUCTION_TREND_SLOPE_BPS ? "down" : "range",
        bidWall: w.bidWall,
        askWall: w.askWall,
        position:
          pos && pos.coinSize !== 0
            ? {
                side: pos.coinSize > 0 ? "LONG" : "SHORT",
                size: pos.coinSize,
                entry: pos.entryPrice,
                realized: Number(pos.realizedPnL.toFixed(4)),
              }
            : null,
        fsm: st ? { side: st.side, entry: st.entry, stop: st.stop, targetTagged: !!st.targetTagged } : null,
      };
    }
    const positions = inventory.all();
    let realized = 0;
    let unreal = 0;
    for (const p of positions) {
      const ctx = ctxCache.get(p.coin);
      const m = (ctx ? inventory.markToMarket(p.coin, ctx.markPrice) : undefined) ?? p;
      realized += m.realizedPnL;
      unreal += m.unrealizedPnL;
    }
    const stats = db.stats(startTs);
    const state = {
      ts: Date.now(),
      startTs,
      cfg: {
        coins: cfg.COINS,
        sizeUsd: cfg.AUCTION_SIZE_USD,
        useMaker: cfg.AUCTION_USE_MAKER,
        useDivergence: cfg.AUCTION_USE_DIVERGENCE,
        useRegime: cfg.AUCTION_USE_REGIME,
        useTrapped: cfg.AUCTION_USE_TRAPPED,
        useWall: cfg.AUCTION_USE_WALL,
        useTrail: cfg.AUCTION_USE_TRAIL,
      },
      global: {
        ...stats,
        realized: Number(realized.toFixed(4)),
        unrealized: Number(unreal.toFixed(4)),
        net: Number((realized + unreal).toFixed(4)),
        openPositions: positions.filter((p) => p.coinSize !== 0).length,
        exits: Object.fromEntries(exitReasons),
      },
      coins: coinsOut,
    };
    try {
      writeFileSync("data/state.json", JSON.stringify(state));
    } catch {
      /* ignore snapshot write errors */
    }
  };
  setInterval(writeState, 5000);

  ws.on("error", (err) => log.error({ err: err.message }, "WS error"));
  ws.connect();

  const shutdown = () => {
    log.info("Shutting down");
    ws.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
