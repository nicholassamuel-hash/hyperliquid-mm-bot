/**
 * Paper-trading fill simulator with QUEUE POSITION model.
 *
 * Improvement over naive: instead of assuming 100% queue priority, we discount
 * fill size by depth ahead of us at our quote price.
 *
 * Algorithm:
 *   When the bot places a quote at price P with size S, snapshot the existing
 *   depth at level P. Our "queue position" is at the BACK of that depth.
 *   When a trade prints that would hit level P:
 *     - If trade size < depth_ahead: we get 0 fill (others ahead get filled).
 *     - If trade size > depth_ahead: we get min(trade.size - depth_ahead, our_size).
 *
 * Maker fee: 0.015% (positive, paid by us at retail tier).
 */
import type { Logger } from "../util/logger.js";
import type { Fill, OurQuote, TradeEvent, OrderbookSnapshot } from "../types.js";
import { BASE_MAKER_FEE } from "../util/math.js";

interface QueueState {
  bidDepthAhead: number;
  askDepthAhead: number;
  snapshotAt: number;
}

export class PaperBook {
  private queueState = new Map<string, QueueState>();

  constructor(private readonly _log: Logger) {
    void this._log;
  }

  /**
   * Snapshot depth at our quote level when we place. Called by runPaper on each place.
   */
  onQuotePlaced(quote: OurQuote, book: OrderbookSnapshot) {
    const bidLevel = book.bids.find((l) => Math.abs(l.price - quote.bidPrice) < 1e-9);
    const askLevel = book.asks.find((l) => Math.abs(l.price - quote.askPrice) < 1e-9);
    this.queueState.set(quote.coin, {
      bidDepthAhead: bidLevel?.size ?? 0,
      askDepthAhead: askLevel?.size ?? 0,
      snapshotAt: quote.placedAt,
    });
  }

  onQuoteCancelled(coin: string) {
    this.queueState.delete(coin);
  }

  matchTrade(quote: OurQuote | undefined, trade: TradeEvent): Fill | null {
    if (!quote) return null;
    if (trade.coin !== quote.coin) return null;
    if (trade.timestamp < quote.placedAt) return null;

    const qs = this.queueState.get(quote.coin);

    if (trade.side === "BUY" && quote.askSize > 0 && quote.askPrice <= trade.price) {
      const ahead = qs?.askDepthAhead ?? 0;
      const consumed = trade.size - ahead;
      if (consumed <= 0) {
        // trade fully absorbed by depth ahead — reduce queue
        if (qs) qs.askDepthAhead = Math.max(0, ahead - trade.size);
        return null;
      }
      // We fill some
      const ourFill = Math.min(consumed, quote.askSize);
      if (qs) qs.askDepthAhead = 0; // we're now at front
      const notional = ourFill * quote.askPrice;
      return {
        coin: quote.coin,
        side: "SELL",
        price: quote.askPrice,
        size: ourFill,
        fee: notional * BASE_MAKER_FEE,
        timestamp: trade.timestamp,
      };
    }

    if (trade.side === "SELL" && quote.bidSize > 0 && quote.bidPrice >= trade.price) {
      const ahead = qs?.bidDepthAhead ?? 0;
      const consumed = trade.size - ahead;
      if (consumed <= 0) {
        if (qs) qs.bidDepthAhead = Math.max(0, ahead - trade.size);
        return null;
      }
      const ourFill = Math.min(consumed, quote.bidSize);
      if (qs) qs.bidDepthAhead = 0;
      const notional = ourFill * quote.bidPrice;
      return {
        coin: quote.coin,
        side: "BUY",
        price: quote.bidPrice,
        size: ourFill,
        fee: notional * BASE_MAKER_FEE,
        timestamp: trade.timestamp,
      };
    }

    return null;
  }
}
