/**
 * Pricing math for Hyperliquid perp MM.
 *
 * Fee model (Hyperliquid 2026):
 *   - Base maker fee: 0.015% (paid by maker)
 *   - Base taker fee: 0.045%
 *   - Maker rebate kicks in at 0.5% of platform maker volume (unreachable retail)
 *   - HYPE staking + volume tiers can reduce fees
 *
 * Funding: paid hourly, longs pay shorts when funding rate positive.
 */
import type { Side } from "../types.js";

export const BASE_MAKER_FEE = 0.00015; // 0.015%
export const BASE_TAKER_FEE = 0.00045; // 0.045%

export function midprice(bestBid: number, bestAsk: number): number {
  return (bestBid + bestAsk) / 2;
}

export function spread(bestBid: number, bestAsk: number): number {
  return bestAsk - bestBid;
}

/** Relative spread as a fraction of mid (bps-friendly). */
export function relativeSpread(bestBid: number, bestAsk: number): number {
  const mid = midprice(bestBid, bestAsk);
  return mid > 0 ? (bestAsk - bestBid) / mid : 0;
}

/** Fee in USD for a trade of `notional` USD at given side. */
export function tradeFee(notionalUsd: number, side: "maker" | "taker"): number {
  return notionalUsd * (side === "maker" ? BASE_MAKER_FEE : BASE_TAKER_FEE);
}

/**
 * Maker edge per round-trip (in basis points of mid).
 * If both sides of our quote fill, we capture the full spread minus adverse cost,
 * minus maker fees, plus any rebate (zero at retail tier).
 */
export function makerEdgePerRoundtrip(
  halfSpreadBps: number,
  adverseCostFraction: number,
): number {
  const captured = 2 * halfSpreadBps; // both sides → full spread
  const adverseCost = captured * adverseCostFraction;
  const feeBps = BASE_MAKER_FEE * 2 * 10_000; // both legs, in bps
  return captured - adverseCost - feeBps;
}

/**
 * Round a price to Hyperliquid's tick grid.
 * Hyperliquid uses up to 5 significant figures for perp prices.
 */
export function roundPrice(price: number, pxDecimals: number): number {
  const factor = Math.pow(10, pxDecimals);
  return Math.round(price * factor) / factor;
}

/** Round a size to asset's szDecimals. */
export function roundSize(size: number, szDecimals: number): number {
  const factor = Math.pow(10, szDecimals);
  return Math.round(size * factor) / factor;
}

/**
 * Estimated liquidation price for an isolated perp position.
 * Simplified: liq when margin = maintenance margin (assume 2% MMR).
 *
 *   long  liq = entry * (1 - 1/lev + MMR)
 *   short liq = entry * (1 + 1/lev - MMR)
 */
export function liquidationPrice(
  entry: number,
  side: Side,
  leverage: number,
  maintenanceMarginRatio = 0.02,
): number {
  if (side === "BUY") {
    return entry * (1 - 1 / leverage + maintenanceMarginRatio);
  }
  return entry * (1 + 1 / leverage - maintenanceMarginRatio);
}

/** Funding cost per hour for a position of given USD notional. */
export function hourlyFundingCost(notionalUsd: number, fundingRate: number): number {
  return notionalUsd * fundingRate;
}
