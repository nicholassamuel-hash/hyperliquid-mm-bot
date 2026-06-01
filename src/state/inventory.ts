import type { Fill, Position } from "../types.js";

/**
 * In-memory perp position tracker. One instance per coin.
 *
 * Differences from binary market inventory:
 *  - coinSize can be negative (short)
 *  - entryPrice replaces avgPrice (financial convention)
 *  - fundingAccrued is tracked separately (accumulates per hour from external feed)
 *  - leverage & marginUsed reported but updated externally
 */
export class Inventory {
  private positions = new Map<string, Position>();

  apply(fill: Fill, leverage = 1): Position {
    const cur = this.positions.get(fill.coin) ?? {
      coin: fill.coin,
      coinSize: 0,
      entryPrice: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      fundingAccrued: 0,
      marginUsed: 0,
      leverage,
    };

    const signedSize = fill.side === "BUY" ? fill.size : -fill.size;

    // Closing or reducing position → realize PnL
    if (cur.coinSize !== 0 && Math.sign(signedSize) !== Math.sign(cur.coinSize)) {
      const closingSize = Math.min(Math.abs(signedSize), Math.abs(cur.coinSize));
      const pnlPerUnit =
        cur.coinSize > 0 ? fill.price - cur.entryPrice : cur.entryPrice - fill.price;
      cur.realizedPnL += closingSize * pnlPerUnit;
    }

    const newSize = cur.coinSize + signedSize;
    if (newSize === 0) {
      cur.entryPrice = 0;
    } else if (cur.coinSize === 0 || Math.sign(signedSize) === Math.sign(cur.coinSize)) {
      // Opening fresh OR adding to same-side position → weight avg entry
      const totalCost =
        cur.entryPrice * Math.abs(cur.coinSize) + fill.price * Math.abs(signedSize);
      cur.entryPrice = totalCost / Math.abs(newSize);
    } else if (Math.sign(newSize) === Math.sign(cur.coinSize)) {
      // Partial close (e.g. BUY reducing a short) — entry of remaining position unchanged
      // (intentionally do nothing)
    } else {
      // Flipping over (e.g. BUY larger than short) — remainder opens at fill price
      cur.entryPrice = fill.price;
    }

    cur.coinSize = newSize;
    cur.realizedPnL -= fill.fee; // positive fee reduces PnL; negative (rebate) adds
    cur.marginUsed = (Math.abs(cur.coinSize) * fill.price) / Math.max(1, cur.leverage);
    this.positions.set(fill.coin, cur);
    return { ...cur };
  }

  markToMarket(coin: string, mark: number): Position | undefined {
    const p = this.positions.get(coin);
    if (!p) return undefined;
    p.unrealizedPnL = p.coinSize * (mark - p.entryPrice);
    return { ...p };
  }

  /** Apply hourly funding tick. Positive funding → longs pay shorts. */
  applyFundingTick(coin: string, fundingRate: number, markPrice: number): Position | undefined {
    const p = this.positions.get(coin);
    if (!p || p.coinSize === 0) return p ? { ...p } : undefined;
    const notional = Math.abs(p.coinSize) * markPrice;
    const cost = notional * fundingRate * Math.sign(p.coinSize);
    p.fundingAccrued += cost;
    p.realizedPnL -= cost;
    return { ...p };
  }

  get(coin: string): Position | undefined {
    const p = this.positions.get(coin);
    return p ? { ...p } : undefined;
  }

  all(): Position[] {
    return Array.from(this.positions.values()).map((p) => ({ ...p }));
  }
}
