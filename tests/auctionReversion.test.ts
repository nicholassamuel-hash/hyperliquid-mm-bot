import { describe, it, expect } from "vitest";
import { AuctionReversion, type AuctionConfig } from "../src/strategy/auctionReversion.js";
import type { AuctionSignals } from "../src/strategy/auctionSignals.js";

const cfg: AuctionConfig = {
  bandK: 2,
  rvolAcceptMax: 1.8,
  deltaConfirm: 0,
  obiConfirm: 0.15,
  stopSigma: 1,
  maxHoldMs: 30 * 60_000,
  cooldownMs: 60_000,
  rvolFailExit: 2.5,
  exitGraceMs: 0,
  targetReversion: 1,
};

// Stub signals: vwap=100, sd=5 → upper2=110, lower2=90, upper1=105, lower1=95.
function fakeSignals(o: {
  warm?: boolean;
  vwap?: number;
  sd?: number;
  rvol: number;
  delta: number;
}): AuctionSignals {
  const vwap = o.vwap ?? 100;
  const sd = o.sd ?? 5;
  return {
    warm: () => o.warm ?? true,
    rvol: () => o.rvol,
    recentDelta: () => o.delta,
    cvd: () => 0,
    vwap: () => vwap,
    sd: () => sd,
    bands: () => ({
      vwap,
      sd,
      upper1: vwap + sd,
      lower1: vwap - sd,
      upper2: vwap + 2 * sd,
      lower2: vwap - 2 * sd,
    }),
  } as unknown as AuctionSignals;
}

describe("AuctionReversion entries", () => {
  it("holds inside the value area", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 100, fakeSignals({ rvol: 1, delta: 0 }), 0, 1000);
    expect(i.action).toBe("hold");
  });

  it("fades SHORT at the upper band on a failed auction with sellers", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 111, fakeSignals({ rvol: 1.0, delta: -1 }), 0, 1000);
    expect(i.action).toBe("enter_short");
    expect(i.side).toBe("SELL");
    const st = s.getState("BTC")!;
    expect(st.side).toBe("SHORT");
    expect(st.entry).toBe(111);
    expect(st.stop).toBeCloseTo(116); // 111 + 1σ(5)
  });

  it("does NOT fade when RVOL signals acceptance (Law 3 trap filter)", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 111, fakeSignals({ rvol: 2.5, delta: -1 }), 0, 1000);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("acceptance");
  });

  it("does NOT fade short without reversal confirmation", () => {
    const s = new AuctionReversion(cfg);
    // price above value, quiet, but delta still positive (buyers) and OBI flat
    const i = s.onUpdate("BTC", 111, fakeSignals({ rvol: 1.0, delta: 5 }), 0, 1000);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("no reversal confirm");
  });

  it("fades LONG at the lower band with buyers (delta)", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 1000);
    expect(i.action).toBe("enter_long");
    expect(i.side).toBe("BUY");
    expect(s.getState("BTC")!.stop).toBeCloseTo(84); // 89 - 1σ(5)
  });

  it("fades LONG via OBI confirmation when delta alone is insufficient", () => {
    const s = new AuctionReversion(cfg);
    const i = s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: -1 }), 0.2, 1000);
    expect(i.action).toBe("enter_long");
  });
});

describe("AuctionReversion exits", () => {
  it("exits a LONG when price reverts to VWAP (take profit)", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 1000);
    const i = s.onUpdate("BTC", 101, fakeSignals({ rvol: 1.0, delta: 0 }), 0, 2000);
    expect(i.action).toBe("exit");
    expect(i.side).toBe("SELL");
    expect(i.reason).toContain("target");
    expect(s.getState("BTC")).toBeUndefined();
  });

  it("exits a LONG on stop", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 1000); // stop 84
    const i = s.onUpdate("BTC", 83, fakeSignals({ rvol: 1.0, delta: 0 }), 0, 2000);
    expect(i.action).toBe("exit");
    expect(i.reason).toBe("stop");
  });

  it("exits a SHORT when price reverts to VWAP", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 111, fakeSignals({ rvol: 1.0, delta: -1 }), 0, 1000);
    const i = s.onUpdate("BTC", 99, fakeSignals({ rvol: 1.0, delta: 0 }), 0, 2000);
    expect(i.action).toBe("exit");
    expect(i.side).toBe("BUY");
  });

  it("cuts a SHORT on acceptance against us (breakout)", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 111, fakeSignals({ rvol: 1.0, delta: -1 }), 0, 1000);
    // price still high but a strong up-spike with positive delta = breakout against our short
    const i = s.onUpdate("BTC", 112, fakeSignals({ rvol: 3.0, delta: 10 }), 0, 2000);
    expect(i.action).toBe("exit");
    expect(i.reason).toContain("acceptance against");
  });

  it("enforces cooldown after an exit", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 1000); // enter long
    s.onUpdate("BTC", 101, fakeSignals({ rvol: 1.0, delta: 0 }), 0, 2000); // exit at vwap (lastExit=2000)
    // immediate re-entry attempt within cooldown window
    const i = s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 5000);
    expect(i.action).toBe("hold");
    expect(i.reason).toBe("cooldown");
  });

  it("enforces a time stop", () => {
    const s = new AuctionReversion(cfg);
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1.0, delta: 1 }), 0, 1000);
    const i = s.onUpdate("BTC", 95, fakeSignals({ rvol: 1.0, delta: 0 }), 0, 1000 + 30 * 60_000);
    expect(i.action).toBe("exit");
    expect(i.reason).toBe("time stop");
  });
});

describe("AuctionReversion v2 tuning (grace / partial target / profit gate)", () => {
  it("partial target: exits at the configured reversion fraction, not full VWAP", () => {
    // vwap=100, entry=89 → target = 89 + 0.6*(100-89) = 95.6
    const s = new AuctionReversion({ ...cfg, targetReversion: 0.6 });
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1, delta: 1 }), 0, 1000);
    expect(s.onUpdate("BTC", 95, fakeSignals({ rvol: 1, delta: 0 }), 0, 2000).action).toBe("hold");
    const i = s.onUpdate("BTC", 96, fakeSignals({ rvol: 1, delta: 0 }), 0, 3000);
    expect(i.action).toBe("exit");
    expect(i.reason).toContain("target");
  });

  it("grace period: suppresses the acceptance-against cut right after entry", () => {
    const s = new AuctionReversion({ ...cfg, exitGraceMs: 120_000 });
    s.onUpdate("BTC", 111, fakeSignals({ rvol: 1, delta: -1 }), 0, 1000); // short
    // strong adverse spike WITHIN grace → must NOT cut
    const within = s.onUpdate("BTC", 112, fakeSignals({ rvol: 3, delta: 10 }), 0, 2000);
    expect(within.action).toBe("hold");
    // same spike AFTER grace → cut
    const after = s.onUpdate("BTC", 112, fakeSignals({ rvol: 3, delta: 10 }), 0, 1000 + 130_000);
    expect(after.action).toBe("exit");
    expect(after.reason).toContain("acceptance against");
  });

  it("profit gate: does not cut a position that is already in profit", () => {
    const s = new AuctionReversion({ ...cfg, exitGraceMs: 0 });
    s.onUpdate("BTC", 89, fakeSignals({ rvol: 1, delta: 1 }), 0, 1000); // long, entry 89
    // price 94 = in profit (< target 100), strong selling spike → profit gate blocks the cut
    const i = s.onUpdate("BTC", 94, fakeSignals({ rvol: 3, delta: -10 }), 0, 2000);
    expect(i.action).toBe("hold");
  });
});
