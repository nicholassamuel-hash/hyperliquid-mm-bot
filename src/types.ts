/**
 * Shared domain types for Hyperliquid perp MM.
 */

export type Side = "BUY" | "SELL";

export interface BookLevel {
  price: number;
  size: number; // in coin units (e.g. 0.001 BTC)
}

export interface OrderbookSnapshot {
  coin: string; // e.g. "BTC", "ETH", "SOL"
  bids: BookLevel[]; // sorted high to low
  asks: BookLevel[]; // sorted low to high
  timestamp: number;
}

export interface PriceChangeEvent {
  coin: string;
  bestBid: number;
  bestAsk: number;
  timestamp: number;
}

export interface TradeEvent {
  coin: string;
  side: Side;
  price: number;
  size: number;
  timestamp: number;
}

export interface OurQuote {
  coin: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  placedAt: number;
}

export interface Fill {
  coin: string;
  side: Side; // BUY = our bid filled, SELL = our ask filled
  price: number;
  size: number;
  fee: number; // positive = paid, negative = rebate
  timestamp: number;
}

/**
 * Perp position. Differs from binary market:
 *   - shares → coinSize (can be negative for short)
 *   - includes fundingAccrued (perp-specific)
 *   - includes liquidationPrice estimate
 */
export interface Position {
  coin: string;
  coinSize: number; // net long (positive) or short (negative)
  entryPrice: number;
  realizedPnL: number;
  unrealizedPnL: number;
  fundingAccrued: number; // cumulative funding paid/received
  marginUsed: number; // USD margin locked
  leverage: number;
}

/**
 * Perp market context — needed for MM decisions.
 *
 * Hyperliquid tick & size precision rules:
 *   - szDecimals from meta.universe[i]
 *   - Price has up to 5 significant figures; integer prices are always allowed.
 *     For prices >= 1e5, tick = 1. For prices < 1e5, tick = price / 1e5 rounded.
 *   - We compute pxDecimals dynamically from markPrice using the 5-sig-fig rule.
 *   - minSz = 10 ** -szDecimals (the smallest tradeable size).
 */
export interface MarketContext {
  coin: string;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number; // per hour, can be negative
  openInterest: number;
  szDecimals: number; // size precision per Hyperliquid asset config
  pxDecimals: number; // price decimal places, derived from markPrice
  tickSize: number; // smallest allowable price increment
  minSz: number; // smallest allowable size in coin units
  maxLeverage: number;
}
