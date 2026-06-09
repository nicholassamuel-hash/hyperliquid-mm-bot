import { describe, it, expect } from "vitest";
import { simulateDirectionalFill } from "../src/sim/directionalBook.js";
import { BASE_TAKER_FEE, BASE_MAKER_FEE } from "../src/util/math.js";
import type { Position } from "../src/types.js";

const book = { bestBid: 99, bestAsk: 101 };

function pos(coinSize: number): Position {
  return {
    coin: "BTC",
    coinSize,
    entryPrice: 100,
    realizedPnL: 0,
    unrealizedPnL: 0,
    fundingAccrued: 0,
    marginUsed: 0,
    leverage: 1,
  };
}

describe("simulateDirectionalFill", () => {
  it("enters long at the ask (taker) with taker fee", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "enter_long", side: "BUY", reason: "x" },
      ...book,
      sizeUsd: 10.1,
      ts: 1,
    })!;
    expect(f.side).toBe("BUY");
    expect(f.price).toBe(101);
    expect(f.size).toBeCloseTo(10.1 / 101); // 0.1
    expect(f.fee).toBeCloseTo(f.size * 101 * BASE_TAKER_FEE);
  });

  it("enters short at the bid", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "enter_short", side: "SELL", reason: "x" },
      ...book,
      sizeUsd: 9.9,
      ts: 1,
    })!;
    expect(f.side).toBe("SELL");
    expect(f.price).toBe(99);
  });

  it("exits the full position size", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "exit", side: "SELL", reason: "target" },
      ...book,
      sizeUsd: 5,
      ts: 2,
      position: pos(0.42),
    })!;
    expect(f.side).toBe("SELL");
    expect(f.size).toBeCloseTo(0.42);
    expect(f.price).toBe(99); // closing a long sells into the bid
  });

  it("returns null on hold", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "hold", reason: "x" },
      ...book,
      sizeUsd: 10,
      ts: 1,
    });
    expect(f).toBeNull();
  });

  it("fills maker at the limit price with the maker fee", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "enter_short", side: "SELL", reason: "x", maker: true, limitPrice: 110 },
      ...book, // bestBid 99, bestAsk 101
      sizeUsd: 11,
      ts: 1,
    })!;
    expect(f.price).toBe(110); // limit price, not the touch (99/101)
    expect(f.size).toBeCloseTo(11 / 110);
    expect(f.fee).toBeCloseTo(f.size * 110 * BASE_MAKER_FEE);
    expect(BASE_MAKER_FEE).toBeLessThan(BASE_TAKER_FEE); // sanity: maker cheaper
  });

  it("returns null when size rounds below the minimum", () => {
    const f = simulateDirectionalFill({
      coin: "BTC",
      intent: { action: "enter_long", side: "BUY", reason: "x" },
      ...book,
      sizeUsd: 0.0001,
      ts: 1,
      szDecimals: 2, // 0.0001/101 → ~1e-6 → rounds to 0
    });
    expect(f).toBeNull();
  });
});
