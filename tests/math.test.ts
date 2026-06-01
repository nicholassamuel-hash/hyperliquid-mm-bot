import { describe, it, expect } from "vitest";
import {
  midprice,
  spread,
  relativeSpread,
  tradeFee,
  makerEdgePerRoundtrip,
  roundPrice,
  roundSize,
  liquidationPrice,
  hourlyFundingCost,
  BASE_MAKER_FEE,
  BASE_TAKER_FEE,
} from "../src/util/math.js";

describe("midprice", () => {
  it("returns simple average", () => {
    expect(midprice(60000, 60100)).toBeCloseTo(60050);
  });
});

describe("spread / relativeSpread", () => {
  it("computes spread and relative spread", () => {
    expect(spread(60000, 60030)).toBe(30);
    expect(relativeSpread(60000, 60030)).toBeCloseTo(30 / 60015, 6);
  });
});

describe("tradeFee", () => {
  it("maker fee 0.015%", () => {
    expect(tradeFee(10_000, "maker")).toBeCloseTo(10_000 * BASE_MAKER_FEE);
  });
  it("taker fee 0.045%", () => {
    expect(tradeFee(10_000, "taker")).toBeCloseTo(10_000 * BASE_TAKER_FEE);
  });
});

describe("makerEdgePerRoundtrip", () => {
  it("positive when half-spread covers fees", () => {
    // 5 bps half-spread → 10 bps captured. Fees 2 * 1.5bps = 3bps. Net > 0.
    expect(makerEdgePerRoundtrip(5, 0)).toBeGreaterThan(0);
  });
  it("negative when adverse cost too high", () => {
    expect(makerEdgePerRoundtrip(5, 1)).toBeLessThan(0);
  });
});

describe("roundPrice / roundSize", () => {
  it("rounds to decimals", () => {
    expect(roundPrice(60000.12345, 2)).toBeCloseTo(60000.12);
    expect(roundSize(0.123456, 4)).toBeCloseTo(0.1235);
  });
});

describe("liquidationPrice", () => {
  it("long liq is below entry", () => {
    const liq = liquidationPrice(60000, "BUY", 10);
    expect(liq).toBeLessThan(60000);
    expect(liq).toBeGreaterThan(0);
  });
  it("short liq is above entry", () => {
    const liq = liquidationPrice(60000, "SELL", 10);
    expect(liq).toBeGreaterThan(60000);
  });
  it("higher leverage → closer liq to entry", () => {
    const liqLowLev = liquidationPrice(60000, "BUY", 2);
    const liqHighLev = liquidationPrice(60000, "BUY", 20);
    expect(liqHighLev).toBeGreaterThan(liqLowLev);
  });
});

describe("hourlyFundingCost", () => {
  it("positive funding → cost for longs", () => {
    expect(hourlyFundingCost(10_000, 0.0001)).toBeCloseTo(1);
  });
  it("negative funding → income for longs", () => {
    expect(hourlyFundingCost(10_000, -0.0001)).toBeCloseTo(-1);
  });
});
