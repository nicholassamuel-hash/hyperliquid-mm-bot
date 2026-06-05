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
  /**
   * thresholdBps: drift early-warning band, e.g. 5 = 5 bps = 0.05% of mid.
   * staleToleranceBps: how far the opposite side must move PAST our quote before
   *   it counts as stale. 0 = twitchy (cancels on first touch + drift active);
   *   >0 disables drift and lets quotes rest through oscillation (suits join mode).
   */
  constructor(
    private readonly thresholdBps: number,
    private readonly staleToleranceBps = 0,
  ) {}

  /**
   * Returns an AdverseSignal if our quote should be cancelled, else null.
   */
  check(quote: OurQuote | undefined, event: PriceChangeEvent): AdverseSignal | null {
    if (!quote) return null;
    if (event.coin !== quote.coin) return null;

    const mid = (event.bestBid + event.bestAsk) / 2;
    if (!mid) return null;

    // Stale tolerance: the opposite side must move PAST our quote by more than
    // this before it counts as stale. 0 = cancel the instant the touch reaches
    // us (very twitchy in join mode, where our quote sits AT the touch).
    const staleTol = (this.staleToleranceBps / 10_000) * mid;

    // 1. Best bid moved past our ask (beyond tolerance) — stale
    if (event.bestBid >= quote.askPrice + staleTol) {
      return {
        reason: "ask_moved_up",
        magnitudeBps: ((event.bestBid - quote.askPrice) / mid) * 10_000,
      };
    }
    // 2. Best ask moved past our bid (beyond tolerance) — stale
    if (event.bestAsk <= quote.bidPrice - staleTol) {
      return {
        reason: "bid_moved_down",
        magnitudeBps: ((quote.bidPrice - event.bestAsk) / mid) * 10_000,
      };
    }

    // 3 & 4. Drift early-warning — only meaningful when we quote AWAY from the
    // touch (outside mode). In join/improve mode the opposite touch sits within
    // ~1 spread of our quote, so a threshold wider than the spread fires every
    // tick. Disable drift once a stale tolerance is configured.
    if (this.staleToleranceBps === 0) {
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
    }

    return null;
  }
}
