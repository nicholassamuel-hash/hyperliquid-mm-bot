/**
 * Backtest engine — replay a recorded JSONL through current strategy.
 *
 * Usage: npm run backtest -- recordings/BTC_2026-06-01.jsonl
 *
 * Reports final P&L, fill rate, adverse rate. Does NOT touch live exchange.
 */
import fs from "node:fs";
import readline from "node:readline";
import { loadConfig } from "../config.js";
import { createLogger } from "../util/logger.js";
import { MarketMaker } from "../strategy/marketMaker.js";
import { PaperBook } from "./paperBook.js";
import { Inventory } from "../state/inventory.js";
import type { OrderbookSnapshot, TradeEvent, PriceChangeEvent } from "../types.js";

interface EventRec {
  type: "book" | "trade" | "priceChange";
  ts: number;
  data: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npm run backtest -- <recording.jsonl>");
    process.exit(1);
  }
  const filepath = args[0]!;
  if (!fs.existsSync(filepath)) {
    console.error(`File not found: ${filepath}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const log = createLogger("info");
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

  const counts = {
    book: 0,
    trade: 0,
    priceChange: 0,
    placed: 0,
    cancelled_adverse: 0,
    cancelled_skip: 0,
    fills: 0,
  };
  let lastBook: OrderbookSnapshot | undefined;

  const rl = readline.createInterface({ input: fs.createReadStream(filepath) });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: EventRec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec.type === "book") {
      counts.book++;
      const snap = rec.data as OrderbookSnapshot;
      lastBook = snap;
      const pos = inventory.get(snap.coin);
      const cmd = mm.onBook(snap, undefined, pos);
      if (cmd.kind === "place" && cmd.quote) {
        counts.placed++;
        paperBook.onQuotePlaced(cmd.quote, snap);
      } else if (cmd.kind === "cancel") {
        if (cmd.outcome === "cancelled_adverse") counts.cancelled_adverse++;
        else if (cmd.outcome === "cancelled_skip") counts.cancelled_skip++;
        paperBook.onQuoteCancelled(snap.coin);
      }
    } else if (rec.type === "priceChange") {
      counts.priceChange++;
      const event = rec.data as PriceChangeEvent;
      const cmd = mm.onPriceChange(event);
      if (cmd.kind === "cancel") {
        counts.cancelled_adverse++;
        paperBook.onQuoteCancelled(event.coin);
      }
    } else if (rec.type === "trade") {
      counts.trade++;
      const trade = rec.data as TradeEvent;
      const quote = mm.getQuote(trade.coin);
      const fill = paperBook.matchTrade(quote, trade);
      if (fill) {
        counts.fills++;
        inventory.apply(fill);
      }
    }
  }

  const positions = inventory.all();
  if (lastBook) {
    for (const p of positions) {
      inventory.markToMarket(p.coin, (lastBook.bids[0]!.price + lastBook.asks[0]!.price) / 2);
    }
  }

  const fillRate = counts.placed > 0 ? (counts.fills / counts.placed) * 100 : 0;
  const adverseRate =
    counts.placed > 0 ? (counts.cancelled_adverse / counts.placed) * 100 : 0;
  let totalRealized = 0;
  let totalUnrealized = 0;
  for (const p of inventory.all()) {
    totalRealized += p.realizedPnL;
    totalUnrealized += p.unrealizedPnL;
  }

  log.info(
    {
      ...counts,
      fillRatePct: fillRate.toFixed(2),
      adverseRatePct: adverseRate.toFixed(2),
      realized: totalRealized.toFixed(6),
      unrealized: totalUnrealized.toFixed(6),
      net: (totalRealized + totalUnrealized).toFixed(6),
    },
    "Backtest complete",
  );
  for (const p of inventory.all()) log.info(p, "Final position");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
