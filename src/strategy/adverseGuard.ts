/**
 * Adverse selection guard for perp MM.
 *
 * Hyperliquid perp adverse selection patterns differ slightly from binary:
 *   - Best opposite side moves past our quote (definite stale)
 *   - Best opposite moves within threshold of our quote (informed flow)
 *   - Funding rate flips/spikes (signals large position rotation)
 *
 * Note: we don't track per-event taker size here (Hyperliquid bundles trade
 * events). Adverse via large-trade signal is handled in MarketMaker.onTrade.
 */
import type { OurQuote, PriceChangeEvent } from "../types.js";

export interface AdverseSignal {
  reason: "ask_moved_up" | "bid_moved_down" | "ask_drift_against" | "bid_drift_against";
  magnitudeBps: number;
}

export class AdverseGuard {
  /** thresholdBps: e.g. 5 = 5 basis points = 0.05% relative to mid. */
  constructor(private readonly thresholdBps: number) {}

  /**
   * Returns an AdverseSignal if our quote should be cancelled, else null.
   */
  check(quote: OurQuote | undefined, event: PriceChangeEvent): AdverseSignal | null {
    if (!quote) return null;
    if (event.coin !== quote.coin) return null;

    const mid = (event.bestBid + event.bestAsk) / 2;
    if (!mid) return null;

    // 1. Best bid moved past our ask — definite stale
    if (event.bestBid >= quote.askPrice) {
      return {
        reason: "ask_moved_up",
        magnitudeBps: ((event.bestBid - quote.askPrice) / mid) * 10_000,
      };
    }
    // 2. Best ask moved past our bid — definite stale
    if (event.bestAsk <= quote.bidPrice) {
      return {
        reason: "bid_moved_down",
        magnitudeBps: ((quote.bidPrice - event.bestAsk) / mid) * 10_000,
      };
    }

    const threshold = (this.thresholdBps / 10_000) * mid;

    // 3. Best bid drifting up toward our ask (informed buy pressure)
    if (event.bestBid >= quote.askPrice - threshold) {
      return {
        reason: "ask_drift_against",
        magnitudeBps: ((event.bestBid - (quote.askPrice - threshold)) / mid) * 10_000,
      };
    }
    // 4. Best ask drifting down toward our bid (informed sell pressure)
    if (event.bestAsk <= quote.bidPrice + threshold) {
      return {
        reason: "bid_drift_against",
        magnitudeBps: ((quote.bidPrice + threshold - event.bestAsk) / mid) * 10_000,
      };
    }

    return null;
  }
}
