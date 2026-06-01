import { describe, it, expect } from "vitest";
import { PaperBook } from "../src/sim/paperBook.js";
import { createLogger } from "../src/util/logger.js";
import type { OurQuote, TradeEvent, OrderbookSnapshot } from "../src/types.js";

const coin = "BTC";
const log = createLogger("error");

function quote(bid = 59995, ask = 60005, placedAt = 1000): OurQuote {
  return { coin, bidPrice: bid, bidSize: 0.001, askPrice: ask, askSize: 0.001, placedAt };
}

function trade(side: "BUY" | "SELL", price: number, size: number, ts = 2000): TradeEvent {
  return { coin, side, price, size, timestamp: ts };
}

function book(bidPrice: number, bidSize: number, askPrice: number, askSize: number): OrderbookSnapshot {
  return {
    coin,
    bids: [{ price: bidPrice, size: bidSize }],
    asks: [{ price: askPrice, size: askSize }],
    timestamp: 1000,
  };
}

describe("PaperBook with queue model", () => {
  it("no fill when trade fully absorbed by queue ahead", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0.005, q.askPrice, 0.005)); // 0.005 ahead on each side
    const f = pb.matchTrade(q, trade("BUY", 60005, 0.003));
    expect(f).toBeNull(); // 0.003 < 0.005 depth ahead → all goes to others
  });

  it("partial fill when trade exceeds queue ahead", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0.005, q.askPrice, 0.005));
    const f = pb.matchTrade(q, trade("BUY", 60005, 0.0065));
    expect(f).not.toBeNull();
    expect(f!.side).toBe("SELL");
    expect(f!.size).toBeCloseTo(0.0015); // 0.0065 - 0.005 = 0.0015
  });

  it("full fill when no queue ahead", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0, q.askPrice, 0)); // empty ahead
    const f = pb.matchTrade(q, trade("BUY", 60005, 0.0005));
    expect(f!.size).toBeCloseTo(0.0005);
  });

  it("caps fill at our quote size", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0, q.askPrice, 0));
    const f = pb.matchTrade(q, trade("BUY", 60005, 10));
    expect(f!.size).toBeCloseTo(0.001); // capped at askSize
  });

  it("ignores trades before our quote was placed", () => {
    const pb = new PaperBook(log);
    const q = quote(59995, 60005, 5000);
    pb.onQuotePlaced(q, book(q.bidPrice, 0, q.askPrice, 0));
    const f = pb.matchTrade(q, trade("BUY", 60005, 0.001, 1000));
    expect(f).toBeNull();
  });

  it("returns null when no quote", () => {
    const pb = new PaperBook(log);
    expect(pb.matchTrade(undefined, trade("BUY", 60005, 0.001))).toBeNull();
  });

  it("fills our bid on sell taker at or below our bid", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0, q.askPrice, 0));
    const f = pb.matchTrade(q, trade("SELL", 59995, 0.0005));
    expect(f!.side).toBe("BUY");
    expect(f!.size).toBeCloseTo(0.0005);
  });

  it("queue erodes after partial fill (next trade gets through easier)", () => {
    const pb = new PaperBook(log);
    const q = quote();
    pb.onQuotePlaced(q, book(q.bidPrice, 0.005, q.askPrice, 0.005));
    // First trade: 0.003 — absorbed entirely by queue, queue now 0.002
    const f1 = pb.matchTrade(q, trade("BUY", 60005, 0.003));
    expect(f1).toBeNull();
    // Second trade: 0.003 — 0.003 - 0.002 = 0.001 fills us
    const f2 = pb.matchTrade(q, trade("BUY", 60005, 0.003));
    expect(f2).not.toBeNull();
    expect(f2!.size).toBeCloseTo(0.001);
  });
});
