import { describe, it, expect } from "vitest";
import { detectWalls } from "../src/strategy/orderbook.js";
import type { OrderbookSnapshot } from "../src/types.js";

function book(bidSizes: number[], askSizes: number[]): OrderbookSnapshot {
  return {
    coin: "BTC",
    bids: bidSizes.map((s, i) => ({ price: 100 - i, size: s })),
    asks: askSizes.map((s, i) => ({ price: 101 + i, size: s })),
    timestamp: 1000,
  };
}

describe("detectWalls", () => {
  it("finds no wall in a flat book", () => {
    const w = detectWalls(book([5, 5, 5, 5, 5], [5, 5, 5, 5, 5]));
    expect(w.bidWall).toBe(false);
    expect(w.askWall).toBe(false);
    expect(w.bidWallRatio).toBeCloseTo(1);
  });

  it("detects a bid-side wall (long absorber)", () => {
    const w = detectWalls(book([5, 50, 5, 5, 5], [5, 5, 5, 5, 5]), 10, 3);
    expect(w.bidWall).toBe(true);
    expect(w.bidWallRatio).toBeGreaterThanOrEqual(3);
    expect(w.askWall).toBe(false);
  });

  it("detects an ask-side wall (short absorber)", () => {
    const w = detectWalls(book([5, 5, 5, 5, 5], [5, 5, 40, 5, 5]), 10, 3);
    expect(w.askWall).toBe(true);
    expect(w.bidWall).toBe(false);
  });

  it("returns no wall when there are too few levels", () => {
    const w = detectWalls(book([10, 1], [10, 1]));
    expect(w.bidWall).toBe(false);
    expect(w.askWall).toBe(false);
  });
});
