import { describe, it, expect } from "vitest";
import { VolTracker } from "../src/util/vol.js";
import { inferPricePrecision } from "../src/client/hyperliquid.js";

describe("VolTracker", () => {
  it("zero with no data", () => {
    const v = new VolTracker(10);
    expect(v.stddevBps()).toBe(0);
  });

  it("zero with constant mid", () => {
    const v = new VolTracker(10);
    for (let i = 0; i < 5; i++) v.push(100, i);
    expect(v.stddevBps()).toBe(0);
  });

  it("positive bps with varying mid", () => {
    const v = new VolTracker(10);
    v.push(100, 0);
    v.push(101, 1);
    v.push(99, 2);
    v.push(102, 3);
    expect(v.stddevBps()).toBeGreaterThan(0);
  });

  it("respects window size (FIFO)", () => {
    const v = new VolTracker(3);
    for (let i = 0; i < 10; i++) v.push(100 + i, i);
    expect(v.count()).toBe(3);
  });

  it("log returns positive when prices change", () => {
    const v = new VolTracker(10);
    v.push(100, 0);
    v.push(102, 1);
    v.push(98, 2);
    expect(v.logReturnStdBps()).toBeGreaterThan(0);
  });
});

describe("inferPricePrecision", () => {
  it("BTC at $73000 → tick 1", () => {
    const p = inferPricePrecision(73000);
    expect(p.tickSize).toBe(1);
    expect(p.pxDecimals).toBe(0);
  });
  it("HYPE at $73 → tick 0.001", () => {
    const p = inferPricePrecision(73);
    expect(p.tickSize).toBeCloseTo(0.001);
    expect(p.pxDecimals).toBe(3);
  });
  it("SOL at $81 → tick 0.001", () => {
    const p = inferPricePrecision(81);
    expect(p.tickSize).toBeCloseTo(0.001);
  });
  it("low price 0.012 → small tick", () => {
    const p = inferPricePrecision(0.012);
    expect(p.tickSize).toBeLessThan(0.0001);
  });
  it("handles invalid input", () => {
    expect(inferPricePrecision(0).tickSize).toBeGreaterThan(0);
    expect(inferPricePrecision(NaN).tickSize).toBeGreaterThan(0);
  });
});
