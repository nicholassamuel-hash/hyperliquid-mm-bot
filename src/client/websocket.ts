/**
 * Hyperliquid WSS subscriber.
 *
 * Endpoint: wss://api.hyperliquid.xyz/ws
 * Subscription types we use:
 *   - { method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } }
 *   - { method: "subscribe", subscription: { type: "trades", coin: "BTC" } }
 *   - { method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } }
 *
 * Server expects ping every 50s (we send, server pongs).
 * Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { Logger } from "../util/logger.js";
import type {
  OrderbookSnapshot,
  PriceChangeEvent,
  TradeEvent,
  BookLevel,
  Side,
} from "../types.js";

const WSS_URL = "wss://api.hyperliquid.xyz/ws";
const PING_INTERVAL_MS = 50_000;

export interface HyperliquidWSEvents {
  book: (snapshot: OrderbookSnapshot) => void;
  priceChange: (event: PriceChangeEvent) => void;
  trade: (event: TradeEvent) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
}

export class HyperliquidWS extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private closed = false;

  constructor(
    private readonly coins: string[],
    private readonly log: Logger,
  ) {
    super();
  }

  connect(): void {
    this.closed = false;
    this.log.info({ url: WSS_URL, coins: this.coins }, "WS connecting");
    this.ws = new WebSocket(WSS_URL);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.log.info("WS connected, subscribing");
      this.subscribe();
      this.startPing();
      this.emit("open");
    });

    this.ws.on("message", (data) => this.onMessage(data));

    this.ws.on("close", (code, reason) => {
      this.log.warn({ code, reason: reason.toString() }, "WS closed");
      this.stopPing();
      this.emit("close", code, reason.toString());
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.log.error({ err: err.message }, "WS error");
      this.emit("error", err);
    });
  }

  private subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const coin of this.coins) {
      this.ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "l2Book", coin },
        }),
      );
      this.ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "trades", coin },
        }),
      );
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private onMessage(raw: WebSocket.RawData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "WS parse fail");
      return;
    }
    this.handleEvent(parsed);
  }

  private handleEvent(ev: unknown) {
    if (!ev || typeof ev !== "object") return;
    const e = ev as Record<string, unknown>;
    const channel = String(e.channel ?? "").toLowerCase();
    const data = e.data;

    switch (channel) {
      case "l2book":
        this.emit("book", normalizeBook(data));
        // Also derive priceChange event from book top
        this.emit("priceChange", deriveTopOfBook(data));
        break;
      case "trades":
        if (Array.isArray(data)) {
          for (const t of data) this.emit("trade", normalizeTrade(t));
        }
        break;
      case "pong":
      case "subscriptionresponse":
        // No-op
        break;
      default:
        this.log.trace({ ev: e }, "ws unknown event");
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.log.info({ delay, attempt: this.reconnectAttempts }, "WS reconnect scheduled");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

// --- normalizers --- //

function num(x: unknown): number {
  return typeof x === "string" ? Number.parseFloat(x) : Number(x);
}

function asLevels(arr: unknown): BookLevel[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((l) => {
      const o = l as Record<string, unknown>;
      // Hyperliquid l2Book levels: { px: "62000.0", sz: "0.5", n: 1 }
      return { price: num(o.px), size: num(o.sz) };
    })
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
}

function normalizeBook(data: unknown): OrderbookSnapshot {
  // Hyperliquid l2Book payload: { coin: "BTC", levels: [bidsArr, asksArr], time: <ms> }
  const d = (data ?? {}) as Record<string, unknown>;
  const levels = (d.levels as unknown[]) ?? [[], []];
  const bidsRaw = levels[0] ?? [];
  const asksRaw = levels[1] ?? [];
  return {
    coin: String(d.coin ?? ""),
    bids: asLevels(bidsRaw).sort((a, b) => b.price - a.price),
    asks: asLevels(asksRaw).sort((a, b) => a.price - b.price),
    timestamp: num(d.time) || Date.now(),
  };
}

function deriveTopOfBook(data: unknown): PriceChangeEvent {
  const snap = normalizeBook(data);
  const bestBid = snap.bids[0]?.price ?? 0;
  const bestAsk = snap.asks[0]?.price ?? 0;
  return {
    coin: snap.coin,
    bestBid,
    bestAsk,
    timestamp: snap.timestamp,
  };
}

function normalizeTrade(t: unknown): TradeEvent {
  const o = (t ?? {}) as Record<string, unknown>;
  // Hyperliquid trade: { coin, side: "B"|"A", px, sz, hash, time }
  // side B = buy aggressor (taker BUY), A = sell aggressor (taker SELL)
  const sideRaw = String(o.side ?? "").toUpperCase();
  const side: Side = sideRaw === "B" ? "BUY" : "SELL";
  return {
    coin: String(o.coin ?? ""),
    side,
    price: num(o.px),
    size: num(o.sz),
    timestamp: num(o.time) || Date.now(),
  };
}
