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

  it("stddevBps with window argument samples only last N", () => {
    const v = new VolTracker(100);
    // First 50 bars: stable around 100 (very low vol)
    for (let i = 0; i < 50; i++) v.push(100 + Math.sin(i) * 0.01, i);
    // Last 5 bars: jump to wildly varying prices (spike)
    v.push(105, 50);
    v.push(95, 51);
    v.push(110, 52);
    v.push(90, 53);
    v.push(105, 54);
    const shortVol = v.stddevBps(5);
    const longVol = v.stddevBps(); // all buffered
    expect(shortVol).toBeGreaterThan(longVol);
  });

  it("spikeRatio returns >3 when recent vol dominates", () => {
    const v = new VolTracker(100);
    for (let i = 0; i < 50; i++) v.push(100 + Math.sin(i) * 0.001, i);
    // 5 chaotic bars
    v.push(110, 50);
    v.push(90, 51);
    v.push(105, 52);
    v.push(95, 53);
    v.push(108, 54);
    const ratio = v.spikeRatio(5, 30);
    expect(ratio).toBeGreaterThan(3);
  });

  it("spikeRatio returns 0 if not enough baseline history", () => {
    const v = new VolTracker(50);
    for (let i = 0; i < 10; i++) v.push(100 + i, i);
    expect(v.spikeRatio(5, 30)).toBe(0);
  });

  it("spikeRatio near 1 when vol is stable", () => {
    const v = new VolTracker(100);
    for (let i = 0; i < 50; i++) v.push(100 + Math.random() * 0.5, i);
    const ratio = v.spikeRatio(5, 30);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(3); // not spiking
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
