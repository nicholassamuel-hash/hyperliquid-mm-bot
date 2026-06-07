import { describe, it, expect } from "vitest";
import { AuctionSignals } from "../src/strategy/auctionSignals.js";

// barMs=1000 (1s bars), maxBars=240, warmBars=3 for easy timestamp control.
function sig() {
  return new AuctionSignals(1000, 240, 3);
}

describe("AuctionSignals VWAP + bands", () => {
  it("VWAP equals the constant trade price; sd ~ 0; bands collapse", () => {
    const s = sig();
    for (let i = 0; i <= 5; i++) {
      s.pushTrade(100, 1, i % 2 === 0 ? "BUY" : "SELL", i * 1000);
    }
    expect(s.vwap()).toBeCloseTo(100);
    expect(s.sd()).toBeCloseTo(0);
    const b = s.bands();
    expect(b.upper2).toBeCloseTo(100);
    expect(b.lower2).toBeCloseTo(100);
  });

  it("VWAP is volume-weighted", () => {
    const s = sig();
    // (100*1 + 200*3) / (1+3) = 175
    s.pushTrade(100, 1, "BUY", 0);
    s.pushTrade(200, 3, "BUY", 0);
    expect(s.vwap()).toBeCloseTo(175);
  });

  it("bands widen with price dispersion", () => {
    const s = sig();
    s.pushTrade(90, 1, "SELL", 0);
    s.pushTrade(110, 1, "BUY", 0);
    const b = s.bands();
    expect(b.vwap).toBeCloseTo(100);
    expect(b.sd).toBeGreaterThan(0);
    expect(b.upper1).toBeGreaterThan(100);
    expect(b.lower1).toBeLessThan(100);
  });
});

describe("AuctionSignals delta / CVD", () => {
  it("delta = aggressor buy − sell; CVD accumulates on bar finalize", () => {
    const s = sig();
    s.pushTrade(100, 5, "BUY", 0); // bar0
    s.pushTrade(100, 2, "SELL", 0); // bar0 delta = +3
    expect(s.recentDelta()).toBeCloseTo(3); // current bar only
    expect(s.cvd()).toBe(0); // bar0 not finalized yet

    s.pushTrade(100, 1, "BUY", 1000); // advances → finalizes bar0
    expect(s.cvd()).toBeCloseTo(3);
    expect(s.recentDelta()).toBeCloseTo(4); // bar0(+3) + current bar1(+1)
  });

  it("net selling produces negative delta", () => {
    const s = sig();
    s.pushTrade(100, 1, "BUY", 0);
    s.pushTrade(100, 6, "SELL", 0);
    expect(s.recentDelta()).toBeCloseTo(-5);
  });
});

describe("AuctionSignals RVOL", () => {
  it("RVOL > 1 when the last completed bar is high-volume", () => {
    const s = sig();
    s.pushTrade(100, 10, "BUY", 0); // bar0 vol 10
    s.pushTrade(100, 10, "BUY", 1000); // → finalize bar0; bar1 vol 10
    s.pushTrade(100, 50, "BUY", 2000); // → finalize bar1; bar2 vol 50
    s.pushTrade(100, 1, "BUY", 3000); // → finalize bar2 (vol 50); bar3 current
    // last completed = bar2 (50); avg prior = (10+10+... )? prior = bar0,bar1 = 10 → wait bar2 is last
    // bars = [bar0(10), bar1(10), bar2(50)]; last=50, avg prior=(10+10)/2=10 → rvol=5
    expect(s.rvol()).toBeCloseTo(5);
  });

  it("RVOL ~ 1 for uniform volume", () => {
    const s = sig();
    for (let i = 0; i <= 5; i++) s.pushTrade(100, 10, "BUY", i * 1000);
    expect(s.rvol()).toBeCloseTo(1);
  });
});

describe("AuctionSignals warm-up", () => {
  it("not warm until warmBars completed bars exist", () => {
    const s = sig(); // warmBars=3
    s.pushTrade(100, 1, "BUY", 0); // bar0 forming
    s.pushTrade(100, 1, "BUY", 1000); // 1 completed
    expect(s.warm()).toBe(false);
    s.pushTrade(100, 1, "BUY", 2000); // 2 completed
    expect(s.warm()).toBe(false);
    s.pushTrade(100, 1, "BUY", 3000); // 3 completed
    expect(s.warm()).toBe(true);
  });
});

describe("AuctionSignals priceNBarsAgo", () => {
  it("returns the representative price of a past completed bar", () => {
    const s = sig();
    s.pushTrade(100, 1, "BUY", 0);
    s.pushTrade(110, 1, "BUY", 1000); // finalize bar0 @100
    s.pushTrade(120, 1, "BUY", 2000); // finalize bar1 @110
    s.pushTrade(130, 1, "BUY", 3000); // finalize bar2 @120 → bars [100,110,120]
    expect(s.priceNBarsAgo(1)).toBeCloseTo(120); // last completed
    expect(s.priceNBarsAgo(3)).toBeCloseTo(100); // 3 back
    expect(s.priceNBarsAgo(99)).toBe(0); // not enough history
  });
});
