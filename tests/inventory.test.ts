import { describe, it, expect } from "vitest";
import { Inventory } from "../src/state/inventory.js";
import type { Fill } from "../src/types.js";

const coin = "BTC";

function fill(side: "BUY" | "SELL", price: number, size: number, fee = 0): Fill {
  return { coin, side, price, size, fee, timestamp: Date.now() };
}

describe("Inventory (perp)", () => {
  it("tracks long position from a single buy", () => {
    const inv = new Inventory();
    const p = inv.apply(fill("BUY", 60000, 0.01));
    expect(p.coinSize).toBeCloseTo(0.01);
    expect(p.entryPrice).toBeCloseTo(60000);
  });

  it("averages entry across two buys", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.apply(fill("BUY", 62000, 0.01));
    expect(p.coinSize).toBeCloseTo(0.02);
    expect(p.entryPrice).toBeCloseTo(61000);
  });

  it("realizes PnL on closing trade", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.apply(fill("SELL", 61000, 0.01));
    expect(p.coinSize).toBeCloseTo(0);
    expect(p.realizedPnL).toBeCloseTo(10); // 0.01 * 1000
  });

  it("handles flip from long to short", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.apply(fill("SELL", 61000, 0.02));
    expect(p.coinSize).toBeCloseTo(-0.01);
    expect(p.realizedPnL).toBeCloseTo(10);
    expect(p.entryPrice).toBeCloseTo(61000);
  });

  it("fees reduce realized PnL", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01, 0.5));
    const p = inv.apply(fill("SELL", 61000, 0.01, 0.5));
    expect(p.realizedPnL).toBeCloseTo(9); // 10 - 1
  });

  it("mark-to-market computes unrealized PnL", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.markToMarket(coin, 61500);
    expect(p?.unrealizedPnL).toBeCloseTo(15);
  });

  it("funding tick reduces PnL for longs when positive rate", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.applyFundingTick(coin, 0.0001, 60000); // 1bp/hr
    // notional = 600, cost = 600 * 0.0001 * +1 = 0.06
    expect(p?.fundingAccrued).toBeCloseTo(0.06);
    expect(p?.realizedPnL).toBeCloseTo(-0.06);
  });

  it("partial close on short does NOT recompute entry price (regression)", () => {
    // Bug found 2026-06-01: weight-averaging applied during partial close inflated entry.
    const inv = new Inventory();
    inv.apply(fill("SELL", 73.364, 0.0273)); // open short
    const p1 = inv.apply(fill("BUY", 73.342, 0.01)); // partial close
    expect(p1.coinSize).toBeCloseTo(-0.0173);
    expect(p1.entryPrice).toBeCloseTo(73.364); // unchanged
    expect(p1.realizedPnL).toBeCloseTo(0.01 * 0.022, 6); // captured spread on closed portion
  });

  it("partial close on long does NOT recompute entry price (regression)", () => {
    const inv = new Inventory();
    inv.apply(fill("BUY", 60000, 0.01));
    const p = inv.apply(fill("SELL", 61000, 0.004));
    expect(p.coinSize).toBeCloseTo(0.006);
    expect(p.entryPrice).toBeCloseTo(60000); // unchanged
    expect(p.realizedPnL).toBeCloseTo(0.004 * 1000);
  });

  it("funding tick adds PnL for shorts when positive rate", () => {
    const inv = new Inventory();
    inv.apply(fill("SELL", 60000, 0.01));
    const p = inv.applyFundingTick(coin, 0.0001, 60000);
    expect(p?.fundingAccrued).toBeCloseTo(-0.06);
    expect(p?.realizedPnL).toBeCloseTo(0.06);
  });
});
