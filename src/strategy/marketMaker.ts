/**
 * Market maker strategy for Hyperliquid perp.
 *
 * Strategy v2: JOIN OR IMPROVE the touch (not quote outside).
 *
 * Three quoting modes:
 *   - "improve": price-improve by 1 tick (bestBid + tick, bestAsk - tick)
 *   - "join":    quote AT touch (bestBid, bestAsk)
 *   - "outside": legacy mode, quote outside touch by halfSpread (rarely viable)
 *
 * Edge gate: only quote if expected captured spread > 2 * makerFee + adverseBuffer.
 * Skip otherwise — no point quoting when fees eat all edge.
 *
 * Volatility-adaptive: half-spread minimum & adverse threshold scale with
 * recent realized volatility.
 *
 * Order book imbalance (OBI) + funding skew: bias quotes toward/away from
 * pressure direction.
 *
 * Inventory flat-bias: if long, lower the ask (sell eagerly); if short, raise the bid.
 */
import type { Logger } from "../util/logger.js";
import type {
  OrderbookSnapshot,
  OurQuote,
  PriceChangeEvent,
  Position,
  MarketContext,
} from "../types.js";
import { midprice, roundPrice, roundSize, BASE_MAKER_FEE } from "../util/math.js";
import { AdverseGuard } from "./adverseGuard.js";
import { VolTracker } from "../util/vol.js";

export type QuoteMode = "join" | "improve" | "outside";

export interface MMConfig {
  /** Floor on half-spread in bps. Will scale up with vol. */
  halfSpreadBpsMin: number;
  /** Cap on half-spread in bps. */
  halfSpreadBpsMax: number;
  /** Multiplier from realized vol to effective half-spread. */
  volMultiplier: number;
  /** Max position notional in USD. */
  maxPositionUsd: number;
  /** Max margin used in USD. */
  maxMarginUsd: number;
  /** Cancel/replace cooldown (ms). */
  replaceCooldownMs: number;
  /** Adverse threshold floor in bps. */
  adverseThresholdBpsMin: number;
  /** Quote size per side in USD notional. */
  quoteSizeUsd: number;
  /** Funding rate threshold for skew (per hour). */
  fundingSkewThreshold: number;
  /** Quoting mode. */
  quoteMode: QuoteMode;
  /** Min edge in bps needed to bother quoting (after 2x fees). */
  minEdgeBps: number;
  /** OBI sensitivity (0-1). 0 = ignore, 1 = full skew. */
  obiWeight: number;
  /** Inventory flat-bias weight (0-1). */
  invFlatWeight: number;
}

export type QuoteOutcome =
  | "placed"
  | "cancelled_adverse"
  | "cancelled_skip"
  | "noop";

export interface QuoteCommand {
  kind: "place" | "cancel" | "noop";
  quote?: OurQuote;
  reason?: string;
  outcome: QuoteOutcome;
}

export class MarketMaker {
  private currentQuote = new Map<string, OurQuote>();
  private lastReplaceAt = new Map<string, number>();
  private adverse: AdverseGuard;
  private vol = new Map<string, VolTracker>();

  constructor(
    private readonly cfg: MMConfig,
    private readonly log: Logger,
  ) {
    this.adverse = new AdverseGuard(cfg.adverseThresholdBpsMin);
  }

  private getVol(coin: string): VolTracker {
    let v = this.vol.get(coin);
    if (!v) {
      v = new VolTracker(60);
      this.vol.set(coin, v);
    }
    return v;
  }

  /**
   * Compute desired prices for current book + context + position.
   * Returns null if no quote should be placed.
   */
  private computePrices(
    snap: OrderbookSnapshot,
    ctx: MarketContext | undefined,
    position: Position | undefined,
  ): { bid: number; ask: number; halfSpreadBps: number } | null {
    const bestBid = snap.bids[0]!.price;
    const bestAsk = snap.asks[0]!.price;
    const mid = midprice(bestBid, bestAsk);
    if (!Number.isFinite(mid) || mid <= 0) return null;

    const tickSize = ctx?.tickSize ?? 0.0001;
    const naturalSpreadBps = ((bestAsk - bestBid) / mid) * 10_000;

    // Update vol & compute adaptive half-spread
    this.getVol(snap.coin).push(mid, snap.timestamp);
    const realizedVolBps = this.getVol(snap.coin).stddevBps();
    const volScaled = Math.max(
      this.cfg.halfSpreadBpsMin,
      realizedVolBps * this.cfg.volMultiplier,
    );
    const halfSpreadBps = Math.min(this.cfg.halfSpreadBpsMax, volScaled);

    // Edge gate: captured spread - 2*fee - small adverse buffer must be > minEdgeBps
    const feeBps = BASE_MAKER_FEE * 10_000; // 1.5 bps
    const adverseBufferBps = halfSpreadBps * 0.3;

    let bid: number;
    let ask: number;

    if (this.cfg.quoteMode === "join") {
      bid = bestBid;
      ask = bestAsk;
    } else if (this.cfg.quoteMode === "improve") {
      bid = bestBid + tickSize;
      ask = bestAsk - tickSize;
      // If improve would cross, fall back to join
      if (bid >= ask) {
        bid = bestBid;
        ask = bestAsk;
      }
    } else {
      // outside (legacy)
      const halfSpread = (halfSpreadBps / 10_000) * mid;
      bid = mid - halfSpread;
      ask = mid + halfSpread;
      if (bid >= bestAsk) bid = bestAsk - tickSize;
      if (ask <= bestBid) ask = bestBid + tickSize;
    }

    // Edge check based on effective captured spread (mid-to-our-price)
    const capturedBpsPerSide = ((mid - bid) / mid) * 10_000;
    const expectedEdgeBps = capturedBpsPerSide * 2 - 2 * feeBps - adverseBufferBps;

    if (this.cfg.quoteMode !== "outside" && expectedEdgeBps < this.cfg.minEdgeBps) {
      // For join/improve modes, "captured" may be negative or tiny.
      // Still allow when natural spread is wide enough — captured = halfSpread
      // when joining is the same as our offset from mid. If too tight, skip.
      const naturalEdgeBps = naturalSpreadBps - 2 * feeBps;
      if (naturalEdgeBps < this.cfg.minEdgeBps) return null;
    }

    // Funding skew
    let skewBps = 0;
    if (ctx && Math.abs(ctx.fundingRate) > this.cfg.fundingSkewThreshold) {
      // positive funding → longs pay → bias short (push quotes down)
      skewBps += (ctx.fundingRate > 0 ? -1 : 1) * (halfSpreadBps * 0.3);
    }

    // OBI skew
    const obi = this.computeOBI(snap);
    skewBps += obi * this.cfg.obiWeight * halfSpreadBps * 0.5;

    // Inventory flat-bias
    if (position && position.coinSize !== 0) {
      const posNotional = Math.abs(position.coinSize) * mid;
      const utilization = Math.min(1, posNotional / this.cfg.maxPositionUsd);
      // long → want to sell → push quotes down to attract sells
      skewBps -= Math.sign(position.coinSize) * utilization * this.cfg.invFlatWeight * halfSpreadBps;
    }

    const skewAmount = (skewBps / 10_000) * mid;
    bid += skewAmount;
    ask += skewAmount;

    // Final tick alignment
    bid = roundPrice(bid, ctx?.pxDecimals ?? 4);
    ask = roundPrice(ask, ctx?.pxDecimals ?? 4);

    // Don't cross
    if (bid >= ask) return null;

    return { bid, ask, halfSpreadBps };
  }

  /**
   * OBI = (bidDepth - askDepth) / (bidDepth + askDepth) over top 3 levels.
   * Positive → buy pressure, negative → sell pressure.
   */
  private computeOBI(snap: OrderbookSnapshot, depth = 3): number {
    const bidSum = snap.bids.slice(0, depth).reduce((s, l) => s + l.size, 0);
    const askSum = snap.asks.slice(0, depth).reduce((s, l) => s + l.size, 0);
    const total = bidSum + askSum;
    return total > 0 ? (bidSum - askSum) / total : 0;
  }

  onBook(
    snap: OrderbookSnapshot,
    ctx?: MarketContext,
    position?: Position,
  ): QuoteCommand {
    if (snap.bids.length === 0 || snap.asks.length === 0) {
      return { kind: "noop", reason: "empty book", outcome: "noop" };
    }

    const prices = this.computePrices(snap, ctx, position);
    if (!prices) {
      return this.cancel(snap.coin, "no edge", "cancelled_skip");
    }

    const { bid, ask } = prices;
    const mid = midprice(snap.bids[0]!.price, snap.asks[0]!.price);

    // Size: convert USD to coin units, validate against min size
    const szDecimals = ctx?.szDecimals ?? 4;
    const minSz = ctx?.minSz ?? Math.pow(10, -szDecimals);

    let bidSize = roundSize(this.cfg.quoteSizeUsd / bid, szDecimals);
    let askSize = roundSize(this.cfg.quoteSizeUsd / ask, szDecimals);

    if (bidSize < minSz) bidSize = 0;
    if (askSize < minSz) askSize = 0;

    // Inventory limits — IMPORTANT: allow the CLOSING side past caps,
    // only block side that would ADD to position. Otherwise bot gets
    // stuck unable to flatten (bug observed 2026-06-02).
    if (position) {
      const posNotional = Math.abs(position.coinSize) * mid;
      if (posNotional >= this.cfg.maxPositionUsd) {
        if (position.coinSize > 0) bidSize = 0; // long & at cap → don't buy more
        else if (position.coinSize < 0) askSize = 0; // short & at cap → don't sell more
      }
      if (position.marginUsed >= this.cfg.maxMarginUsd) {
        if (position.coinSize > 0) {
          bidSize = 0; // long → block adds, allow asks to close
        } else if (position.coinSize < 0) {
          askSize = 0; // short → block adds, allow bids to close
        } else {
          // Flat but margin used? Edge case — block both
          bidSize = 0;
          askSize = 0;
        }
      }
    }

    if (bidSize === 0 && askSize === 0) {
      return this.cancel(snap.coin, "size below min or inventory", "cancelled_skip");
    }

    // Cooldown
    const now = snap.timestamp;
    const last = this.lastReplaceAt.get(snap.coin) ?? 0;
    const cur = this.currentQuote.get(snap.coin);
    const tickSize = ctx?.tickSize ?? 0.0001;
    if (cur && now - last < this.cfg.replaceCooldownMs) {
      if (
        Math.abs(cur.bidPrice - bid) < tickSize / 2 &&
        Math.abs(cur.askPrice - ask) < tickSize / 2
      ) {
        return { kind: "noop", reason: "no change", outcome: "noop" };
      }
    }

    const quote: OurQuote = {
      coin: snap.coin,
      bidPrice: bid,
      bidSize,
      askPrice: ask,
      askSize,
      placedAt: now,
    };

    this.currentQuote.set(snap.coin, quote);
    this.lastReplaceAt.set(snap.coin, now);
    return { kind: "place", quote, outcome: "placed" };
  }

  onPriceChange(event: PriceChangeEvent): QuoteCommand {
    const cur = this.currentQuote.get(event.coin);
    if (!cur) return { kind: "noop", reason: "no quote", outcome: "noop" };

    const signal = this.adverse.check(cur, event);
    if (signal) {
      this.log.warn(
        { coin: event.coin, reason: signal.reason, bps: signal.magnitudeBps.toFixed(2) },
        "Adverse signal — cancelling",
      );
      return this.cancel(event.coin, `adverse: ${signal.reason}`, "cancelled_adverse");
    }
    return { kind: "noop", outcome: "noop" };
  }

  private cancel(coin: string, reason: string, outcome: QuoteOutcome): QuoteCommand {
    this.currentQuote.delete(coin);
    return { kind: "cancel", reason, outcome };
  }

  cancelAll(): string[] {
    const coins = Array.from(this.currentQuote.keys());
    this.currentQuote.clear();
    return coins;
  }

  getQuote(coin: string): OurQuote | undefined {
    const q = this.currentQuote.get(coin);
    return q ? { ...q } : undefined;
  }

  /** Current realized vol estimate (for telemetry). */
  getVolBps(coin: string): number {
    return this.getVol(coin).stddevBps();
  }
}
