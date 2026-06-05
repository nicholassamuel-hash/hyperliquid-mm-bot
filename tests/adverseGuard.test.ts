import { describe, it, expect } from "vitest";
import { AdverseGuard } from "../src/strategy/adverseGuard.js";
import type { OurQuote, PriceChangeEvent } from "../src/types.js";

const coin = "BTC";

function quote(bid = 59995, ask = 60005): OurQuote {
  return { coin, bidPrice: bid, bidSize: 0.001, askPrice: ask, askSize: 0.001, placedAt: 1000 };
}

function event(bestBid: number, bestAsk: number): PriceChangeEvent {
  return { coin, bestBid, bestAsk, timestamp: 2000 };
}

describe("AdverseGuard (perp, bps)", () => {
  it("clears when book stable", () => {
    const g = new AdverseGuard(3);
    // threshold = 3 bps * mid 60000 = 18 USD. Quote ask=60005, bid=59995.
    // For "stable": bestBid must be < 60005-18=59987, bestAsk must be > 59995+18=60013.
    expect(g.check(quote(), event(59970, 60030))).toBeNull();
  });

  it("flags ask moved up past our ask", () => {
    const g = new AdverseGuard(3);
    const sig = g.check(quote(), event(60010, 60015));
    expect(sig?.reason).toBe("ask_moved_up");
  });

  it("flags bid moved down past our bid", () => {
    const g = new AdverseGuard(3);
    const sig = g.check(quote(), event(59980, 59990));
    expect(sig?.reason).toBe("bid_moved_down");
  });

  it("flags drift toward our ask within threshold", () => {
    const g = new AdverseGuard(5);
    // mid ≈ 60000, threshold = 5 bps * 60000 = 30. ask=60005. Trigger when bestBid >= 59975.
    const sig = g.check(quote(), event(59980, 60003));
    expect(sig?.reason).toBe("ask_drift_against");
  });

  it("returns null when no quote", () => {
    const g = new AdverseGuard(3);
    expect(g.check(undefined, event(60000, 60010))).toBeNull();
  });
});

describe("AdverseGuard stale tolerance (relaxed join-mode guard)", () => {
  it("ignores a touch within tolerance and skips drift", () => {
    // tol 3 bps ≈ 18 USD @ mid 60000. bestBid 60010 is only +5 past ask 60005 →
    // within tolerance → no stale; drift disabled because tolerance > 0 → null.
    const g = new AdverseGuard(3, 3);
    expect(g.check(quote(), event(60010, 60015))).toBeNull();
  });

  it("flags a touch that penetrates beyond tolerance", () => {
    // tol 0.5 bps ≈ 3 USD. bestBid 60010 is +5 past ask 60005 → beyond → stale.
    const g = new AdverseGuard(3, 0.5);
    expect(g.check(quote(), event(60010, 60015))?.reason).toBe("ask_moved_up");
  });

  it("default tolerance (0) keeps legacy twitchy behavior", () => {
    // No tolerance arg → cancels the instant the touch reaches our ask.
    const g = new AdverseGuard(3);
    expect(g.check(quote(), event(60005, 60015))?.reason).toBe("ask_moved_up");
  });
});
