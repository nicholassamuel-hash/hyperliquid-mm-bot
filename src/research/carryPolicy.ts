/**
 * Carry (funding-harvest) policy replay — pure functions, no I/O.
 *
 * Position model: delta-neutral cash-and-carry (long spot + short perp, equal
 * notional). While in position, each funding settlement accrues
 * `notional × rate` (positive rate pays the short). Entering or exiting costs
 * `costRtBps / 2` of notional each way (both legs' fees + spread combined).
 *
 * Policy: EWMA forecast of the annualized funding rate with hysteresis —
 * enter when EWMA APR > thetaInApr, exit when EWMA APR < thetaOutApr.
 * thetaInApr = -Infinity replays an "always-in" baseline.
 */
import type { FundingPoint } from "./fundingSources.js";

export interface CarryParams {
  /** Enter when EWMA annualized funding exceeds this (decimal APR, e.g. 0.05 = 5%). */
  thetaInApr: number;
  /** Exit when EWMA annualized funding drops below this. Must be < thetaInApr. */
  thetaOutApr: number;
  /** EWMA half-life in hours (funding is strongly autocorrelated; ~72h works). */
  ewmaHalfLifeHours: number;
  /** Round-trip cost in bps of notional (entry + exit, both legs, fees + spread). */
  costRtBps: number;
  /** Position notional in USD. */
  notional: number;
}

export interface CarryResult {
  points: number;
  spanDays: number;
  grossFunding: number; // USD collected (can be negative)
  fees: number; // USD paid on entries+exits
  net: number;
  aprGross: number; // gross funding annualized over the full span (incl. idle time)
  aprNet: number;
  utilization: number; // fraction of span in position
  entries: number;
  exits: number;
  maxDrawdown: number; // worst peak-to-trough of cumulative net (USD)
  worstNegStreakHours: number; // longest run of negative settlements while in position
  avgAprInPosition: number; // average annualized funding while held
}

/** Annualize a per-interval rate. */
export function annualize(rate: number, intervalHours: number): number {
  return rate * (8760 / intervalHours);
}

export function replayCarry(points: FundingPoint[], p: CarryParams): CarryResult {
  const r: CarryResult = {
    points: points.length,
    spanDays: 0,
    grossFunding: 0,
    fees: 0,
    net: 0,
    aprGross: 0,
    aprNet: 0,
    utilization: 0,
    entries: 0,
    exits: 0,
    maxDrawdown: 0,
    worstNegStreakHours: 0,
    avgAprInPosition: 0,
  };
  if (points.length < 2) return r;

  const spanMs = points[points.length - 1]!.ts - points[0]!.ts;
  r.spanDays = spanMs / 86_400_000;
  const oneWayCost = (p.costRtBps / 2 / 1e4) * p.notional;

  let ewma = annualize(points[0]!.rate, points[0]!.intervalHours);
  let inPos = p.thetaInApr === -Infinity; // always-in starts held
  if (inPos) r.entries++; // pay entry once for the baseline too
  if (inPos) r.fees += oneWayCost;

  let hoursInPos = 0;
  let aprSumInPos = 0;
  let nInPos = 0;
  let equity = inPos ? -oneWayCost : 0;
  let peak = equity;
  let negStreak = 0;

  for (const pt of points) {
    const apr = annualize(pt.rate, pt.intervalHours);
    const alpha = 1 - Math.pow(0.5, pt.intervalHours / p.ewmaHalfLifeHours);
    ewma = ewma + alpha * (apr - ewma);

    if (inPos) {
      const pay = p.notional * pt.rate;
      r.grossFunding += pay;
      equity += pay;
      hoursInPos += pt.intervalHours;
      aprSumInPos += apr;
      nInPos++;
      if (pay < 0) {
        negStreak += pt.intervalHours;
        if (negStreak > r.worstNegStreakHours) r.worstNegStreakHours = negStreak;
      } else {
        negStreak = 0;
      }
      if (ewma < p.thetaOutApr) {
        inPos = false;
        r.exits++;
        r.fees += oneWayCost;
        equity -= oneWayCost;
      }
    } else if (ewma > p.thetaInApr) {
      inPos = true;
      r.entries++;
      r.fees += oneWayCost;
      equity -= oneWayCost;
    }

    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > r.maxDrawdown) r.maxDrawdown = dd;
  }

  r.net = r.grossFunding - r.fees;
  const years = spanMs / (365 * 86_400_000);
  r.aprGross = years > 0 ? r.grossFunding / p.notional / years : 0;
  r.aprNet = years > 0 ? r.net / p.notional / years : 0;
  r.utilization = spanMs > 0 ? (hoursInPos * 3_600_000) / spanMs : 0;
  r.avgAprInPosition = nInPos > 0 ? aprSumInPos / nInPos : 0;
  return r;
}

/**
 * Incremental EWMA of the annualized funding rate — the live counterpart of the
 * forecast used in replayCarry, fed one settled funding point at a time.
 */
export class EwmaAprTracker {
  private ewma: number | null = null;

  constructor(private readonly halfLifeHours: number) {}

  /** Feed one settled funding point; returns the updated EWMA APR. */
  push(rate: number, intervalHours: number): number {
    const apr = annualize(rate, intervalHours);
    if (this.ewma === null) {
      this.ewma = apr;
    } else {
      const alpha = 1 - Math.pow(0.5, intervalHours / this.halfLifeHours);
      this.ewma += alpha * (apr - this.ewma);
    }
    return this.ewma;
  }

  /** Current EWMA APR, or null before the first point. */
  get value(): number | null {
    return this.ewma;
  }
}

/** Named policy variants for the standard report grid. */
export const POLICY_GRID: Array<{ name: string; thetaInApr: number; thetaOutApr: number }> = [
  { name: "always-in", thetaInApr: -Infinity, thetaOutApr: -Infinity },
  { name: "exit-if-neg (0/-5%)", thetaInApr: 0, thetaOutApr: -0.05 },
  { name: "baseline (5%/0%)", thetaInApr: 0.05, thetaOutApr: 0 },
  { name: "picky (10%/3%)", thetaInApr: 0.1, thetaOutApr: 0.03 },
];
