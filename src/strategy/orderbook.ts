/**
 * Order-book reading for the auction strategy.
 *
 * Detects large resting "walls" (passive absorbers) near the touch — the
 * counterparty that traps aggressors in a failed breakout. A bid-side wall
 * backs a LONG fade (it absorbs the trapped sellers); an ask-side wall backs a
 * SHORT fade. Per the user's Price_Ladder.pdf: absorption = a big resting limit
 * eating aggressive market orders until they exhaust → reversal.
 *
 * Caveat: from a single L2 snapshot we cannot tell a real wall from a spoof
 * (the PDF filters those by duration). So this is a *conviction booster*, never
 * a sole trigger. (A future version could track wall persistence across snaps.)
 */
import type { OrderbookSnapshot, BookLevel } from "../types.js";

export interface Walls {
  /** Outsized resting bid within `depth` levels (support / long absorber). */
  bidWall: boolean;
  /** Outsized resting ask within `depth` levels (resistance / short absorber). */
  askWall: boolean;
  /** Largest bid-side level size ÷ median level size (1 = flat book). */
  bidWallRatio: number;
  /** Largest ask-side level size ÷ median level size. */
  askWallRatio: number;
}

function sideWall(
  levels: BookLevel[],
  depth: number,
  mult: number,
): { wall: boolean; ratio: number } {
  const sizes = levels
    .slice(0, depth)
    .map((l) => l.size)
    .filter((s) => Number.isFinite(s) && s > 0);
  if (sizes.length < 3) return { wall: false, ratio: 0 };
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const max = sorted[sorted.length - 1]!;
  const ratio = median > 0 ? max / median : 0;
  return { wall: ratio >= mult, ratio };
}

/**
 * @param depth How many levels per side to scan.
 * @param mult  A level counts as a wall if its size ≥ `mult` × the median.
 */
export function detectWalls(book: OrderbookSnapshot, depth = 10, mult = 3): Walls {
  const bid = sideWall(book.bids, depth, mult);
  const ask = sideWall(book.asks, depth, mult);
  return {
    bidWall: bid.wall,
    askWall: ask.wall,
    bidWallRatio: bid.ratio,
    askWallRatio: ask.ratio,
  };
}
