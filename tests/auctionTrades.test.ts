import { describe, it, expect } from "vitest";
import { AuctionReversion, type AuctionConfig } from "../src/strategy/auctionReversion.js";
import type { AuctionSignals } from "../src/strategy/auctionSignals.js";

// NOTE: the StateDB `trades` persistence layer is exercised by `npm run
// analyze:auction` against the live VPS db (real integration) rather than a
// vitest unit — vite-node 5.x can't load the experimental `node:sqlite` builtin.
// These tests cover the behavioural change: entry-time `meta` on entry intents.

// Minimal signals stub (vwap=100, sd=5 → upper2=110, lower2=90).
function stubSignals(o: { rvol: number; delta: number; slope?: number }): AuctionSignals {
  return {
    warm: () => true,
    rvol: () => o.rvol,
    recentDelta: () => o.delta,
    cvd: () => 0,
    vwap: () => 100,
    sd: () => 5,
    priceNBarsAgo: () => 100,
    vwapSlopeBps: () => o.slope ?? 0,
    bands: () => ({ vwap: 100, sd: 5, upper1: 105, lower1: 95, upper2: 110, lower2: 90 }),
  } as unknown as AuctionSignals;
}

const cfg: AuctionConfig = {
  bandK: 2, rvolAcceptMax: 1.8, deltaConfirm: 0, obiConfirm: 0.15, stopSigma: 1,
  maxHoldMs: 1_800_000, cooldownMs: 60_000, rvolFailExit: 2.5, exitGraceMs: 0,
  targetReversion: 1, useDivergence: false, divergenceBars: 5, useMaker: true,
  useRegime: false, regimeBars: 20, trendSlopeBps: 3, useTrapped: false,
  reclaimBars: 3, useWall: false, useTrail: false,
};

describe("AuctionReversion entry meta (instrumentation)", () => {
  it("attaches entry-time context to an entry intent", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 111, stubSignals({ rvol: 1.0, delta: -1, slope: 7 }), 0, 1000);
    expect(i.action).toBe("enter_short");
    expect(i.meta).toBeDefined();
    expect(i.meta!.regime).toBe("up"); // slope 7 > trendSlopeBps 3
    expect(i.meta!.trigger).toBe("band"); // useTrapped false
    expect(i.meta!.rvol).toBeCloseTo(1.0);
    expect(i.meta!.slopeBps).toBeCloseTo(7);
  });

  it("labels range regime when slope is shallow, and does not gate when useRegime is off", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 111, stubSignals({ rvol: 1.0, delta: -1, slope: 1 }), 0, 1000);
    expect(i.action).toBe("enter_short"); // unchanged behaviour: slope computed but gate off
    expect(i.meta!.regime).toBe("range"); // |1| < 3
  });

  it("marks the trapped trigger when useTrapped is on", () => {
    const s = new AuctionReversion({ ...cfg, useTrapped: true });
    // priceAgo 112 (broke above VAH 110) then reclaimed to 109 → trapped short
    const stub = {
      ...stubSignals({ rvol: 1, delta: -1 }),
      priceNBarsAgo: () => 112,
    } as unknown as AuctionSignals;
    const i = s.onUpdate("BTC", 109, stub, 0, 1000);
    expect(i.action).toBe("enter_short");
    expect(i.meta!.trigger).toBe("trapped");
  });

  it("hold intents carry no meta", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 100, stubSignals({ rvol: 1, delta: 0 }), 0, 1000);
    expect(i.action).toBe("hold");
    expect(i.meta).toBeUndefined();
  });
});
