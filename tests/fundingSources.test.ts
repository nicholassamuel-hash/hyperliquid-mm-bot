import { describe, it, expect } from "vitest";
import { normalizePoints } from "../src/research/fundingSources.js";

const H = 3_600_000;

describe("normalizePoints", () => {
  it("dedupes repeated timestamps (paginated sources can overlap)", () => {
    const raw = [
      { ts: 0, rate: 0.0001 },
      { ts: 8 * H, rate: 0.0002 },
      { ts: 8 * H, rate: 0.0002 }, // dup
      { ts: 16 * H, rate: 0.0003 },
    ];
    const out = normalizePoints(raw, 8);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.ts)).toEqual([0, 8 * H, 16 * H]);
  });

  it("infers the settlement interval from timestamp gaps (4h Bitget contracts)", () => {
    const raw = [0, 4, 8, 12].map((h) => ({ ts: h * H, rate: 0.0001 }));
    const out = normalizePoints(raw, 8);
    expect(out[0]!.intervalHours).toBe(8); // first point: fallback
    expect(out[1]!.intervalHours).toBe(4);
    expect(out[3]!.intervalHours).toBe(4);
  });

  it("sorts unordered input and keeps hourly cadence", () => {
    const raw = [2, 0, 1].map((h) => ({ ts: h * H, rate: 0.0001 }));
    const out = normalizePoints(raw, 1);
    expect(out.map((p) => p.ts)).toEqual([0, H, 2 * H]);
    expect(out[1]!.intervalHours).toBe(1);
  });

  it("falls back when a gap is implausibly large (data hole)", () => {
    const raw = [
      { ts: 0, rate: 0.0001 },
      { ts: 100 * H, rate: 0.0001 }, // 100h hole > 24h cap
    ];
    const out = normalizePoints(raw, 8);
    expect(out[1]!.intervalHours).toBe(8); // not 100
  });
});
