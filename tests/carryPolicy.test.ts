import { describe, it, expect } from "vitest";
import { replayCarry, annualize } from "../src/research/carryPolicy.js";
import type { FundingPoint } from "../src/research/fundingSources.js";

/** n hourly points at a constant per-hour rate. */
function constSeries(n: number, rate: number, intervalHours = 1): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (let i = 0; i < n; i++)
    out.push({ ts: i * intervalHours * 3_600_000, rate, intervalHours });
  return out;
}

const base = { ewmaHalfLifeHours: 72, costRtBps: 30, notional: 1000 };

describe("annualize", () => {
  it("scales hourly and 8h rates to APR", () => {
    expect(annualize(0.0000125, 1)).toBeCloseTo(0.1095, 3); // HL baseline ≈ 11% APR
    expect(annualize(0.0001, 8)).toBeCloseTo(0.1095, 3); // same APR expressed per-8h
  });
});

describe("replayCarry — always-in baseline", () => {
  it("collects funding minus one round-trip of fees at constant positive funding", () => {
    // 1 year of hourly funding at 11% APR baseline
    const pts = constSeries(8760, 0.0000125);
    const r = replayCarry(pts, { ...base, thetaInApr: -Infinity, thetaOutApr: -Infinity });
    expect(r.utilization).toBeCloseTo(1, 2);
    expect(r.grossFunding).toBeCloseTo(1000 * 0.0000125 * 8760, 0); // ≈ $109.5
    expect(r.fees).toBeCloseTo(1.5, 5); // entry leg only (never exits): 15bp of $1000
    expect(r.aprNet).toBeGreaterThan(0.1);
    expect(r.exits).toBe(0);
  });

  it("bleeds at constant negative funding and tracks the drawdown + streak", () => {
    const pts = constSeries(1000, -0.0000125);
    const r = replayCarry(pts, { ...base, thetaInApr: -Infinity, thetaOutApr: -Infinity });
    expect(r.grossFunding).toBeLessThan(0);
    expect(r.maxDrawdown).toBeGreaterThan(0);
    expect(r.worstNegStreakHours).toBe(1000);
  });
});

describe("replayCarry — hysteresis", () => {
  it("stays out when funding is below the entry threshold", () => {
    // constant 5% APR but entry needs >10%
    const pts = constSeries(2000, 0.0000057); // ≈ 5% APR
    const r = replayCarry(pts, { ...base, thetaInApr: 0.1, thetaOutApr: 0.03 });
    expect(r.entries).toBe(0);
    expect(r.utilization).toBe(0);
    expect(r.net).toBe(0);
  });

  it("enters on high funding and exits when it decays below thetaOut", () => {
    // 500h at ~22% APR, then 1500h at ~-9% APR → should enter early, exit after decay
    const hi = constSeries(500, 0.000025);
    const lo = constSeries(1500, -0.00001).map((p, i) => ({ ...p, ts: (500 + i) * 3_600_000 }));
    const pts = [...hi, ...lo];
    const r = replayCarry(pts, { ...base, thetaInApr: 0.1, thetaOutApr: 0 });
    expect(r.entries).toBe(1);
    expect(r.exits).toBe(1);
    expect(r.utilization).toBeGreaterThan(0.2);
    expect(r.utilization).toBeLessThan(0.8);
    // collected most of the high-funding phase
    expect(r.grossFunding).toBeGreaterThan(0);
  });

  it("charges half the round-trip cost per side", () => {
    const pts = constSeries(100, 0.000025);
    const r = replayCarry(pts, { ...base, thetaInApr: 0.1, thetaOutApr: 0 });
    expect(r.entries).toBe(1);
    expect(r.exits).toBe(0); // still in at the end
    expect(r.fees).toBeCloseTo((30 / 2 / 1e4) * 1000, 6); // $1.50 one way
  });
});
