/**
 * LIVE trading entry point — uses real Hyperliquid exchange.
 *
 * ⚠️  THIS USES REAL MONEY. ⚠️
 *
 * Pre-flight checks:
 *   - WALLET_PRIVATE_KEY must be set (use npm run gen-wallet)
 *   - DRY_RUN=true is recommended on first launch
 *   - MAX_POSITION_USD acts as a hard cap
 *
 * Safety features:
 *   - Dry-run mode (DRY_RUN=true env)
 *   - Tracks open orders via cid, cancels precise oids
 *   - Emergency cancel-all on SIGINT/SIGTERM
 *   - Consecutive-error kill switch (>5 errors in 60s = stop)
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../util/logger.js";
import { HyperliquidWS } from "../client/websocket.js";
import { PaperClient, createLiveClient, type LiveClient } from "../client/hyperliquid.js";
import { MarketMaker } from "../strategy/marketMaker.js";
import { Inventory } from "../state/inventory.js";
import { StateDB } from "../state/db.js";
import { midprice, roundPrice, roundSize } from "../util/math.js";
import type { MarketContext, OurQuote } from "../types.js";

const MARKET_CTX_REFRESH_MS = 60_000;
const ERROR_WINDOW_MS = 60_000;
const ERROR_KILL_THRESHOLD = 5;

interface OpenOrder {
  cid: string;
  oid?: number;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  placedAt: number;
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const dryRun = process.env.DRY_RUN === "true";

  if (!cfg.WALLET_PRIVATE_KEY) {
    log.fatal(
      "WALLET_PRIVATE_KEY not set. Run `npm run gen-wallet` to generate, then merge into .env.",
    );
    process.exit(1);
  }

  log.warn(
    { coins: cfg.COINS, dryRun, mode: cfg.QUOTE_MODE },
    "▲ LIVE TRADER STARTING — real money mode",
  );
  if (!dryRun) {
    log.warn("⚠️ Set DRY_RUN=true to test without submitting real orders.");
  }

  const live = createLiveClient(cfg.WALLET_PRIVATE_KEY, log, dryRun);
  await live.loadUniverse();
  log.info({ address: live.address() }, "Wallet loaded");

  // Pre-flight: check balance
  try {
    const state = await live.getAccountState();
    const equity = parseFloat(String((state as any)?.marginSummary?.accountValue ?? 0));
    log.info({ equity }, "Account equity (USDC)");
    if (equity < 1 && !dryRun) {
      log.fatal("Account has <$1 USDC. Fund and deposit on Hyperliquid first.");
      process.exit(1);
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "Pre-flight failed");
    process.exit(1);
  }

  const rest = new PaperClient({ log });
  const ws = new HyperliquidWS(cfg.COINS, log);
  const mm = new MarketMaker(
    {
      quoteMode: cfg.QUOTE_MODE,
      halfSpreadBpsMin: cfg.HALF_SPREAD_BPS_MIN,
      halfSpreadBpsMax: cfg.HALF_SPREAD_BPS_MAX,
      volMultiplier: cfg.VOL_MULTIPLIER,
      maxPositionUsd: cfg.MAX_POSITION_USD,
      maxMarginUsd: cfg.MAX_MARGIN_USD,
      replaceCooldownMs: cfg.REPLACE_COOLDOWN_MS,
      adverseThresholdBpsMin: cfg.ADVERSE_THRESHOLD_BPS_MIN,
      quoteSizeUsd: cfg.QUOTE_SIZE_USD,
      fundingSkewThreshold: cfg.FUNDING_SKEW_THRESHOLD,
      minEdgeBps: cfg.MIN_EDGE_BPS,
      obiWeight: cfg.OBI_WEIGHT,
      invFlatWeight: cfg.INV_FLAT_WEIGHT,
    },
    log,
  );
  const inventory = new Inventory();
  const db = new StateDB();

  const ctxCache = new Map<string, MarketContext>();
  const openOrders = new Map<string, OpenOrder[]>(); // per coin
  const recentErrors: number[] = [];

  const recordError = () => {
    const now = Date.now();
    recentErrors.push(now);
    while (recentErrors.length > 0 && recentErrors[0]! < now - ERROR_WINDOW_MS) {
      recentErrors.shift();
    }
    if (recentErrors.length >= ERROR_KILL_THRESHOLD) {
      log.fatal(
        { errors: recentErrors.length, window: ERROR_WINDOW_MS },
        "Too many errors — emergency stop",
      );
      void emergencyStop();
    }
  };

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

  // Cancel all our open orders for a coin
  const cancelCoinOrders = async (coin: string) => {
    const orders = openOrders.get(coin) ?? [];
    for (const o of orders) {
      if (o.oid !== undefined) {
        const assetIdx = live.resolveAsset(coin);
        await live.cancelOrder(assetIdx, o.oid);
      }
    }
    openOrders.set(coin, []);
  };

  // Place a quote pair (bid + ask)
  const placeQuote = async (coin: string, quote: OurQuote, ctx: MarketContext | undefined) => {
    try {
      await cancelCoinOrders(coin);
      const assetIdx = live.resolveAsset(coin);
      const pxDecimals = ctx?.pxDecimals ?? 4;
      const szDecimals = ctx?.szDecimals ?? 4;
      const newOrders: OpenOrder[] = [];

      if (quote.bidSize > 0) {
        const r = await live.placeOrder({
          assetIndex: assetIdx,
          side: "BUY",
          price: String(roundPrice(quote.bidPrice, pxDecimals)),
          size: String(roundSize(quote.bidSize, szDecimals)),
          cid: undefined,
        });
        if (r.ok) {
          newOrders.push({
            cid: `bid-${Date.now()}`,
            oid: r.oid,
            side: "BUY",
            price: quote.bidPrice,
            size: quote.bidSize,
            placedAt: quote.placedAt,
          });
        } else {
          log.warn({ coin, err: r.error }, "Bid order failed");
          recordError();
        }
      }

      if (quote.askSize > 0) {
        const r = await live.placeOrder({
          assetIndex: assetIdx,
          side: "SELL",
          price: String(roundPrice(quote.askPrice, pxDecimals)),
          size: String(roundSize(quote.askSize, szDecimals)),
          cid: undefined,
        });
        if (r.ok) {
          newOrders.push({
            cid: `ask-${Date.now()}`,
            oid: r.oid,
            side: "SELL",
            price: quote.askPrice,
            size: quote.askSize,
            placedAt: quote.placedAt,
          });
        } else {
          log.warn({ coin, err: r.error }, "Ask order failed");
          recordError();
        }
      }

      openOrders.set(coin, newOrders);
    } catch (err) {
      log.error({ coin, err: (err as Error).message }, "placeQuote crashed");
      recordError();
    }
  };

  // Periodic stats
  const startTs = Date.now();
  setInterval(() => {
    const stats = db.stats(startTs);
    const outcomes = db.outcomeStats(startTs);
    log.info({ ...stats, ...outcomes }, "Periodic stats");
  }, 30_000);

  // WS → strategy
  ws.on("book", (snap) => {
    const ctx = ctxCache.get(snap.coin);
    const pos = inventory.get(snap.coin);
    const cmd = mm.onBook(snap, ctx, pos);

    if (cmd.outcome !== "noop") {
      db.recordOutcome(snap.coin, cmd.outcome, snap.timestamp);
    }

    if (cmd.kind === "place" && cmd.quote) {
      db.recordQuote(cmd.quote, false);
      void placeQuote(snap.coin, cmd.quote, ctx);
      log.debug(
        {
          coin: snap.coin,
          bid: cmd.quote.bidPrice,
          ask: cmd.quote.askPrice,
          mid: midprice(snap.bids[0]!.price, snap.asks[0]!.price),
        },
        "Quote placed (LIVE)",
      );
    } else if (cmd.kind === "cancel") {
      void cancelCoinOrders(snap.coin);
      log.debug({ coin: snap.coin, reason: cmd.reason }, "Quote cancelled");
    }
  });

  ws.on("priceChange", (event) => {
    const cmd = mm.onPriceChange(event);
    if (cmd.outcome !== "noop") {
      db.recordOutcome(event.coin, cmd.outcome, event.timestamp);
    }
    if (cmd.kind === "cancel") {
      void cancelCoinOrders(event.coin);
      log.info({ coin: event.coin, reason: cmd.reason }, "Adverse cancel");
    }
  });

  ws.on("error", (err) => {
    log.error({ err: err.message }, "WS error");
    recordError();
  });

  ws.connect();

  const emergencyStop = async () => {
    log.warn("Emergency stop — cancelling all orders");
    try {
      const n = await live.cancelAll();
      log.info({ cancelled: n }, "All orders cancelled");
    } catch (err) {
      log.error({ err: (err as Error).message }, "cancelAll failed");
    }
    ws.close();
    db.close();
    process.exit(1);
  };

  const shutdown = async () => {
    log.info("Graceful shutdown — cancelling orders");
    try {
      await live.cancelAll();
    } catch (err) {
      log.error({ err: (err as Error).message }, "Final cancel failed");
    }
    ws.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  void live as unknown as LiveClient; // keep ref
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
