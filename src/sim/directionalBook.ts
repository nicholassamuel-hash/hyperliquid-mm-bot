/**
 * Paper executor for the directional auction strategy.
 *
 * Models MARKET (taker) fills: entries cross the spread (conservative — pays
 * the spread + 0.045% taker fee), exits close the full position at market.
 * If the strategy is net-profitable paying taker fees, it's robustly so;
 * cheaper maker-limit entries can be modelled later.
 */
import type { AuctionIntent } from "../strategy/auctionReversion.js";
import type { Fill, Position } from "../types.js";
import { roundSize, BASE_TAKER_FEE, BASE_MAKER_FEE } from "../util/math.js";

export function simulateDirectionalFill(opts: {
  coin: string;
  intent: AuctionIntent;
  bestBid: number;
  bestAsk: number;
  sizeUsd: number;
  ts: number;
  position?: Position;
  szDecimals?: number;
}): Fill | null {
  const { coin, intent, bestBid, bestAsk, sizeUsd, ts, position, szDecimals } = opts;
  if (intent.action === "hold" || !intent.side) return null;

  const side = intent.side;
  // Maker: a resting limit at the band (entry) or target (exit) → maker fee.
  // Taker: cross the spread (BUY→ask, SELL→bid) → taker fee. Stops/urgent exits.
  const isMaker = intent.maker === true && !!intent.limitPrice && intent.limitPrice > 0;
  const price = isMaker ? intent.limitPrice! : side === "BUY" ? bestAsk : bestBid;
  if (!Number.isFinite(price) || price <= 0) return null;

  let size: number;
  if (intent.action === "exit") {
    size = Math.abs(position?.coinSize ?? 0);
  } else {
    size = sizeUsd / price;
  }
  if (szDecimals !== undefined) size = roundSize(size, szDecimals);
  if (!Number.isFinite(size) || size <= 0) return null;

  const notional = size * price;
  return {
    coin,
    side,
    price,
    size,
    fee: notional * (isMaker ? BASE_MAKER_FEE : BASE_TAKER_FEE),
    timestamp: ts,
  };
}
