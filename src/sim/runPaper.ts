/**
 * Entry point for paper trading on Hyperliquid perp.
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../util/logger.js";
import { HyperliquidWS } from "../client/websocket.js";
import { PaperClient } from "../client/hyperliquid.js";
import { MarketMaker } from "../strategy/marketMaker.js";
import { PaperBook } from "./paperBook.js";
import { Inventory } from "../state/inventory.js";
import { StateDB } from "../state/db.js";
import { midprice } from "../util/math.js";
import type { MarketContext, OrderbookSnapshot } from "../types.js";

const MARKET_CTX_REFRESH_MS = 60_000;
const FUNDING_TICK_MS = 60 * 60 * 1000;

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);

  log.info({ coins: cfg.COINS, mode: cfg.QUOTE_MODE }, "Hyperliquid MM paper trader starting");
  log.warn("Paper mode: NO real orders will be placed. NO real money at risk.");

  const ws = new HyperliquidWS(cfg.COINS, log);
  const rest = new PaperClient({ log });
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
      quoteSizeUsdByCoin: cfg.QUOTE_SIZE_USD_BY_COIN,
      fundingSkewThreshold: cfg.FUNDING_SKEW_THRESHOLD,
      minEdgeBps: cfg.MIN_EDGE_BPS,
      obiWeight: cfg.OBI_WEIGHT,
      invFlatWeight: cfg.INV_FLAT_WEIGHT,
      volSpikeMultiplier: cfg.VOL_SPIKE_MULTIPLIER,
      volSpikeShortBars: cfg.VOL_SPIKE_SHORT_BARS,
      volSpikeBaselineBars: cfg.VOL_SPIKE_BASELINE_BARS,
      volPauseMs: cfg.VOL_PAUSE_MS,
    },
    log,
  );
  const paperBook = new PaperBook(log);
  const inventory = new Inventory();
  const db = new StateDB();

  // Market context refresh
  const ctxCache = new Map<string, MarketContext>();
  const refreshCtx = async () => {
    for (const coin of cfg.COINS) {
      try {
        const ctx = await rest.getMarketContext(coin);
        if (ctx) {
          ctxCache.set(coin, ctx);
          log.debug(
            {
              coin,
              mark: ctx.markPrice,
              funding: ctx.fundingRate,
              tick: ctx.tickSize,
              minSz: ctx.minSz,
            },
            "Market context refreshed",
          );
        }
      } catch (err) {
        log.warn({ coin, err: (err as Error).message }, "Ctx refresh failed");
      }
    }
  };
  await refreshCtx();
  setInterval(() => void refreshCtx(), MARKET_CTX_REFRESH_MS);

  // Hourly funding tick
  setInterval(() => {
    for (const [coin, ctx] of ctxCache.entries()) {
      const updated = inventory.applyFundingTick(coin, ctx.fundingRate, ctx.markPrice);
      if (updated) {
        log.info(
          { coin, funding: ctx.fundingRate, accrued: updated.fundingAccrued },
          "Funding tick applied",
        );
      }
    }
  }, FUNDING_TICK_MS);

  // Periodic stats including outcome counters
  const startTs = Date.now();
  setInterval(() => {
    const stats = db.stats(startTs);
    const outcomes = db.outcomeStats(startTs);
    const placed = outcomes["placed"] ?? 0;
    const filled = stats.fills;
    const fillRate = placed > 0 ? (filled / placed) * 100 : 0;
    const positions = inventory.all();
    log.info(
      {
        ...stats,
        ...outcomes,
        fillRatePct: fillRate.toFixed(2),
        positions: positions.length,
      },
      "Periodic stats",
    );
    for (const p of positions) {
      const ctx = ctxCache.get(p.coin);
      const marked = ctx ? inventory.markToMarket(p.coin, ctx.markPrice) : p;
      log.info(marked, "Position");
    }
  }, 30_000);

  // Cache last book per coin for paperBook depth snapshots
  const lastBook = new Map<string, OrderbookSnapshot>();

  // WS → strategy
  ws.on("book", (snap) => {
    lastBook.set(snap.coin, snap);
    const ctx = ctxCache.get(snap.coin);
    const pos = inventory.get(snap.coin);
    const cmd = mm.onBook(snap, ctx, pos);

    if (cmd.outcome !== "noop") {
      db.recordOutcome(snap.coin, cmd.outcome, snap.timestamp);
    }

    if (cmd.kind === "place" && cmd.quote) {
      db.recordQuote(cmd.quote);
      paperBook.onQuotePlaced(cmd.quote, snap);
      log.debug(
        {
          coin: snap.coin,
          bid: cmd.quote.bidPrice,
          ask: cmd.quote.askPrice,
          mid: midprice(snap.bids[0]!.price, snap.asks[0]!.price),
          vol: mm.getVolBps(snap.coin).toFixed(2),
        },
        "Quote placed (paper)",
      );
    } else if (cmd.kind === "cancel") {
      paperBook.onQuoteCancelled(snap.coin);
      log.debug({ coin: snap.coin, reason: cmd.reason }, "Quote cancelled");
    }
  });

  ws.on("priceChange", (event) => {
    const cmd = mm.onPriceChange(event);
    if (cmd.outcome !== "noop") {
      db.recordOutcome(event.coin, cmd.outcome, event.timestamp);
    }
    if (cmd.kind === "cancel") {
      paperBook.onQuoteCancelled(event.coin);
      log.info({ coin: event.coin, reason: cmd.reason }, "Adverse cancel");
    }
  });

  ws.on("trade", (trade) => {
    const quote = mm.getQuote(trade.coin);
    const fill = paperBook.matchTrade(quote, trade);
    if (fill) {
      const newPos = inventory.apply(fill);
      db.recordFill(fill);
      // Notify strategy of fill so it can refresh quote (bypass cooldown)
      mm.onFill(fill.coin, fill.side, fill.size);
      log.info(
        {
          coin: trade.coin,
          side: fill.side,
          price: fill.price,
          size: fill.size,
          fee: fill.fee,
          coinSize: newPos.coinSize,
          realized: newPos.realizedPnL,
        },
        "PAPER FILL",
      );
    }
  });

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

  void lastBook; // reserved for future use
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
