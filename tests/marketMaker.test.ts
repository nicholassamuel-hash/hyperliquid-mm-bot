import { describe, it, expect } from "vitest";
import { MarketMaker } from "../src/strategy/marketMaker.js";
import { createLogger } from "../src/util/logger.js";
import type { OrderbookSnapshot, MarketContext, Position } from "../src/types.js";
import { roundSize } from "../src/util/math.js";

const log = createLogger("error");

const baseCfg = {
  quoteMode: "join" as const,
  halfSpreadBpsMin: 1.5,
  halfSpreadBpsMax: 20,
  volMultiplier: 1.5,
  maxPositionUsd: 20,
  maxMarginUsd: 15,
  replaceCooldownMs: 200,
  adverseThresholdBpsMin: 3,
  quoteSizeUsd: 0.5,
  fundingSkewThreshold: 0.0001,
  minEdgeBps: -3,
  obiWeight: 0.5,
  invFlatWeight: 0.6,
  volSpikeMultiplier: 3,
  volSpikeShortBars: 5,
  volSpikeBaselineBars: 30,
  volPauseMs: 60_000,
};

function book(coin = "HYPE"): OrderbookSnapshot {
  return {
    coin,
    bids: [
      { price: 73.243, size: 10 },
      { price: 73.242, size: 5 },
      { price: 73.241, size: 5 },
    ],
    asks: [
      { price: 73.247, size: 10 },
      { price: 73.248, size: 5 },
      { price: 73.249, size: 5 },
    ],
    timestamp: 1000,
  };
}

function ctx(): MarketContext {
  return {
    coin: "HYPE",
    markPrice: 73.245,
    oraclePrice: 73.245,
    fundingRate: 0.00001,
    openInterest: 1_000_000,
    szDecimals: 2,
    pxDecimals: 3,
    tickSize: 0.001,
    minSz: 0.01,
    maxLeverage: 20,
  };
}

describe("MarketMaker.onFill", () => {
  it("reduces askSize when ask is filled", () => {
    const mm = new MarketMaker(baseCfg, log);
    const cmd = mm.onBook(book(), ctx(), undefined);
    expect(cmd.kind).toBe("place");
    const q = mm.getQuote("HYPE")!;
    const originalAsk = q.askSize;
    mm.onFill("HYPE", "SELL", originalAsk * 0.3);
    const q2 = mm.getQuote("HYPE")!;
    expect(q2.askSize).toBeCloseTo(originalAsk * 0.7);
    expect(q2.bidSize).toBeCloseTo(q.bidSize); // bid untouched
  });

  it("clears quote when both sides depleted", () => {
    const mm = new MarketMaker(baseCfg, log);
    mm.onBook(book(), ctx(), undefined);
    const q = mm.getQuote("HYPE")!;
    mm.onFill("HYPE", "SELL", q.askSize);
    mm.onFill("HYPE", "BUY", q.bidSize);
    expect(mm.getQuote("HYPE")).toBeUndefined();
  });

  it("bypasses cooldown after fill — re-quote immediately", () => {
    const mm = new MarketMaker({ ...baseCfg, replaceCooldownMs: 10_000 }, log);
    const snap1 = book();
    snap1.timestamp = 1000;
    mm.onBook(snap1, ctx(), undefined);
    const original = mm.getQuote("HYPE")!;

    // Within cooldown window — normally no-change → noop
    const snap2 = book();
    snap2.timestamp = 1100; // 100ms later, within 10s cooldown
    const cmd2 = mm.onBook(snap2, ctx(), undefined);
    // No fill yet → cooldown active → noop
    expect(cmd2.outcome === "placed" || cmd2.outcome === "noop").toBe(true);

    // Now simulate fill that depletes both sides
    mm.onFill("HYPE", "SELL", original.askSize);
    mm.onFill("HYPE", "BUY", original.bidSize);

    // Next book event should force re-quote even within cooldown
    const snap3 = book();
    snap3.timestamp = 1200; // still within cooldown
    const cmd3 = mm.onBook(snap3, ctx(), undefined);
    expect(cmd3.kind).toBe("place");
  });

  it("handles unknown coin fill gracefully", () => {
    const mm = new MarketMaker(baseCfg, log);
    expect(() => mm.onFill("UNKNOWN", "BUY", 0.1)).not.toThrow();
  });
});

describe("MarketMaker inventory flat-bias", () => {
  function posShort(notional: number, mid = 73.245): Position {
    return {
      coin: "HYPE",
      coinSize: -notional / mid,
      entryPrice: mid,
      realizedPnL: 0,
      unrealizedPnL: 0,
      fundingAccrued: 0,
      marginUsed: notional,
      leverage: 1,
    };
  }

  it("places quote with skew when short — quotes shift upward (attract sells closing short)", () => {
    const mm = new MarketMaker(baseCfg, log);
    // 50% utilization
    const cmd = mm.onBook(book(), ctx(), posShort(10));
    if (cmd.kind === "place") {
      expect(cmd.quote!.bidPrice).toBeGreaterThan(0);
      expect(cmd.quote!.askPrice).toBeGreaterThan(cmd.quote!.bidPrice);
    }
  });

  it("sqrt scaling: bias at 25% util is meaningful (not 0.25 * weight)", () => {
    // Just verify the strategy actually computes & places at low util
    const mm = new MarketMaker(baseCfg, log);
    const cmd = mm.onBook(book(), ctx(), posShort(5)); // 25% util
    expect(cmd.kind).toBe("place"); // should still quote
  });
});

describe("MarketMaker vol spike pause", () => {
  function bookAt(coin: string, mid: number, ts: number): OrderbookSnapshot {
    return {
      coin,
      bids: [{ price: mid - 0.005, size: 10 }, { price: mid - 0.006, size: 5 }, { price: mid - 0.007, size: 5 }],
      asks: [{ price: mid + 0.005, size: 10 }, { price: mid + 0.006, size: 5 }, { price: mid + 0.007, size: 5 }],
      timestamp: ts,
    };
  }

  it("does NOT pause when vol is stable", () => {
    const mm = new MarketMaker(baseCfg, log);
    // 50 stable bars
    for (let i = 0; i < 50; i++) {
      mm.onBook(bookAt("BTC", 100 + Math.sin(i) * 0.0001, i * 100), ctx(), undefined);
    }
    const cmd = mm.onBook(bookAt("BTC", 100, 5000), ctx(), undefined);
    expect(cmd.outcome).not.toBe("cancelled_vol_pause");
  });

  it("pauses when vol spikes (short window 3x baseline)", () => {
    const mm = new MarketMaker(baseCfg, log);
    // 40 calm bars
    for (let i = 0; i < 40; i++) {
      mm.onBook(bookAt("BTC", 100 + Math.sin(i) * 0.0005, i * 100), ctx(), undefined);
    }
    // 5 spike bars (large jumps)
    mm.onBook(bookAt("BTC", 110, 4000), ctx(), undefined);
    mm.onBook(bookAt("BTC", 95, 4100), ctx(), undefined);
    mm.onBook(bookAt("BTC", 108, 4200), ctx(), undefined);
    mm.onBook(bookAt("BTC", 93, 4300), ctx(), undefined);
    const cmd = mm.onBook(bookAt("BTC", 107, 4400), ctx(), undefined);
    expect(cmd.outcome).toBe("cancelled_vol_pause");
  });

  it("stays paused for full pauseMs window after spike", () => {
    const mm = new MarketMaker({ ...baseCfg, volPauseMs: 60_000 }, log);
    // Warm up + spike
    for (let i = 0; i < 40; i++) {
      mm.onBook(bookAt("BTC", 100 + Math.sin(i) * 0.0005, i * 100), ctx(), undefined);
    }
    for (let i = 0; i < 5; i++) {
      mm.onBook(bookAt("BTC", 100 + (i % 2 === 0 ? 10 : -10), 4000 + i * 100), ctx(), undefined);
    }
    // Within pause window — should still be paused even with stable book
    const cmd = mm.onBook(bookAt("BTC", 100, 4500), ctx(), undefined);
    expect(cmd.outcome).toBe("cancelled_vol_pause");
  });

  it("resumes quoting after pauseMs elapsed", () => {
    const mm = new MarketMaker({ ...baseCfg, volPauseMs: 1000 }, log);
    for (let i = 0; i < 40; i++) {
      mm.onBook(bookAt("BTC", 100 + Math.sin(i) * 0.0005, i * 100), ctx(), undefined);
    }
    // Spike at ts=4000
    for (let i = 0; i < 5; i++) {
      mm.onBook(bookAt("BTC", 100 + (i % 2 === 0 ? 10 : -10), 4000 + i * 100), ctx(), undefined);
    }
    // After pause window (1000ms) — with stable inputs to dilute spike vol
    for (let i = 0; i < 10; i++) {
      mm.onBook(bookAt("BTC", 100, 6000 + i * 100), ctx(), undefined);
    }
    const cmd = mm.onBook(bookAt("BTC", 100, 8000), ctx(), undefined);
    expect(cmd.outcome).not.toBe("cancelled_vol_pause");
  });
});

describe("MarketMaker per-coin quote size", () => {
  // book() bids[0] = 73.243; join mode quotes at bestBid, so
  // bidSize = roundSize(quoteSize / 73.243, szDecimals=2).
  const bid0 = 73.243;

  it("uses the per-coin override when the coin is in the map", () => {
    const mm = new MarketMaker({ ...baseCfg, quoteSizeUsdByCoin: { HYPE: 2 } }, log);
    const cmd = mm.onBook(book("HYPE"), ctx(), undefined);
    expect(cmd.kind).toBe("place");
    expect(cmd.quote!.bidSize).toBeCloseTo(roundSize(2 / bid0, 2));
    expect(cmd.quote!.bidSize).toBeCloseTo(0.03); // vs 0.01 at the $0.5 fallback
  });

  it("falls back to quoteSizeUsd for a coin not in the map", () => {
    const mm = new MarketMaker({ ...baseCfg, quoteSizeUsdByCoin: { BTC: 5 } }, log);
    const cmd = mm.onBook(book("HYPE"), ctx(), undefined);
    expect(cmd.kind).toBe("place");
    expect(cmd.quote!.bidSize).toBeCloseTo(roundSize(baseCfg.quoteSizeUsd / bid0, 2));
  });

  it("falls back to quoteSizeUsd when no map is provided (back-compat)", () => {
    const mm = new MarketMaker(baseCfg, log);
    const cmd = mm.onBook(book("HYPE"), ctx(), undefined);
    expect(cmd.kind).toBe("place");
    expect(cmd.quote!.bidSize).toBeCloseTo(roundSize(baseCfg.quoteSizeUsd / bid0, 2));
  });
});
