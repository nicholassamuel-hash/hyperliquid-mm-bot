/**
 * Hyperliquid HTTP API client wrapper.
 *
 * Phase 1: read-only (markets, meta, orderbook snapshot).
 * Live order signing/placement gated behind createLiveClient (Phase 2).
 *
 * Uses @nktkas/hyperliquid SDK under the hood.
 *
 * Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */
import type { Logger } from "../util/logger.js";
import type { MarketContext, Side } from "../types.js";
import * as hl from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

const INFO_URL = "https://api.hyperliquid.xyz/info";

/**
 * Hyperliquid perp price rule: up to 5 significant figures.
 *   - For markPrice >= 100000, integer tick (no decimals)
 *   - For markPrice e.g. 73.243, 5 sig figs → tick 0.001 → pxDecimals=3
 *   - For markPrice e.g. 0.012345, 5 sig figs → tick 0.0000001 → pxDecimals=7
 *
 * Returns pxDecimals (decimal places) and tickSize.
 */
export function inferPricePrecision(markPrice: number): { pxDecimals: number; tickSize: number } {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return { pxDecimals: 4, tickSize: 0.0001 };
  }
  // Magnitude of leading digit (e.g. 73.x → 1, 0.01 → -2)
  const magnitude = Math.floor(Math.log10(markPrice));
  // 5 sig figs means decimals = 4 - magnitude
  const pxDecimals = Math.max(0, 4 - magnitude);
  const tickSize = Math.pow(10, -pxDecimals);
  return { pxDecimals, tickSize };
}

export interface PaperClientOptions {
  log: Logger;
}

/**
 * Read-only client for paper trading.
 * Hits /info POST endpoint (no auth required).
 */
export class PaperClient {
  constructor(private readonly opts: PaperClientOptions) {}

  /** Get perp universe metadata (szDecimals, maxLeverage, etc). */
  async getMeta(): Promise<unknown> {
    return this.post({ type: "meta" });
  }

  /** Get current market contexts (mark price, funding rate, open interest). */
  async getMetaAndAssetCtxs(): Promise<unknown[]> {
    return (await this.post({ type: "metaAndAssetCtxs" })) as unknown[];
  }

  /** Get current orderbook snapshot for a coin. */
  async getL2Book(coin: string): Promise<unknown> {
    return this.post({ type: "l2Book", coin });
  }

  /**
   * Fetch + parse market context for one coin.
   * Returns null if coin not found in universe.
   */
  async getMarketContext(coin: string): Promise<MarketContext | null> {
    const ctxs = await this.getMetaAndAssetCtxs();
    if (!Array.isArray(ctxs) || ctxs.length < 2) return null;

    const meta = ctxs[0] as { universe: Array<Record<string, unknown>> };
    const assetCtxs = ctxs[1] as Array<Record<string, unknown>>;

    const idx = meta.universe.findIndex((u) => u.name === coin);
    if (idx < 0) {
      this.opts.log.warn({ coin }, "Coin not in universe");
      return null;
    }

    const u = meta.universe[idx]!;
    const ac = assetCtxs[idx]!;
    const szDecimals = Number(u.szDecimals ?? 4);
    const markPrice = parseFloat(String(ac.markPx ?? 0));
    return {
      coin,
      markPrice,
      oraclePrice: parseFloat(String(ac.oraclePx ?? 0)),
      fundingRate: parseFloat(String(ac.funding ?? 0)),
      openInterest: parseFloat(String(ac.openInterest ?? 0)),
      szDecimals,
      ...inferPricePrecision(markPrice),
      minSz: Math.pow(10, -szDecimals),
      maxLeverage: Number(u.maxLeverage ?? 1),
    };
  }

  private async post(body: unknown): Promise<unknown> {
    const res = await fetch(INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hyperliquid /info ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

/**
 * Live trading client using @nktkas/hyperliquid.
 *
 * Provides typed wrappers around order/cancel/state operations.
 *
 * SAFETY:
 *   - dryRun flag short-circuits actual submission and logs intended action
 *   - Tracks open orders (cid → oid mapping) for safe cancellation
 *   - Emergency cancellAll method
 */

export interface LiveClientOptions {
  privateKey: `0x${string}`;
  log: Logger;
  dryRun?: boolean;
}

export interface PlaceOrderArgs {
  assetIndex: number;
  side: Side;
  price: string;
  size: string;
  reduceOnly?: boolean;
  cid?: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  oid?: number;
  filledQty?: number;
  avgPrice?: number;
  error?: string;
}

export class LiveClient {
  private readonly account;
  private readonly exchange: hl.ExchangeClient;
  private readonly info: hl.InfoClient;
  private universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> = [];
  /** Map from our client id → exchange oid */
  private openOids = new Map<string, number>();

  constructor(private readonly opts: LiveClientOptions) {
    this.account = privateKeyToAccount(opts.privateKey);
    const transport = new hl.HttpTransport();
    this.exchange = new hl.ExchangeClient({ wallet: this.account, transport });
    this.info = new hl.InfoClient({ transport });
  }

  address(): string {
    return this.account.address;
  }

  /** Fetch and cache universe — required to resolve assetIndex per coin. */
  async loadUniverse(): Promise<void> {
    const meta = await this.info.meta();
    this.universe = (meta.universe ?? []).map((u: any) => ({
      name: String(u.name),
      szDecimals: Number(u.szDecimals ?? 4),
      maxLeverage: Number(u.maxLeverage ?? 1),
    }));
  }

  /** Resolve asset index for a coin ticker (e.g. "BTC" → 0). */
  resolveAsset(coin: string): number {
    const idx = this.universe.findIndex((u) => u.name === coin);
    if (idx < 0) throw new Error(`Coin ${coin} not in universe`);
    return idx;
  }

  /** User's perp account state. */
  async getAccountState() {
    return this.info.clearinghouseState({ user: this.account.address as `0x${string}` });
  }

  /** Place a single GTC limit order. */
  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    const { assetIndex, side, price, size, reduceOnly = false, cid } = args;

    if (this.opts.dryRun) {
      this.opts.log.info(
        { assetIndex, side, price, size, reduceOnly, cid },
        "[DRY-RUN] Would place order",
      );
      return { ok: true };
    }

    try {
      const resp = await this.exchange.order({
        orders: [
          {
            a: assetIndex,
            b: side === "BUY",
            p: price,
            s: size,
            r: reduceOnly,
            t: { limit: { tif: "Gtc" } },
            ...(cid ? { c: cid as `0x${string}` } : {}),
          } as any,
        ],
        grouping: "na",
      });

      const status = (resp as any)?.response?.data?.statuses?.[0];
      if (status?.resting?.oid !== undefined) {
        const oid = Number(status.resting.oid);
        if (cid) this.openOids.set(cid, oid);
        return { ok: true, oid };
      }
      if (status?.filled !== undefined) {
        const f = status.filled;
        return {
          ok: true,
          oid: Number(f.oid),
          filledQty: parseFloat(String(f.totalSz ?? f.sz ?? 0)),
          avgPrice: parseFloat(String(f.avgPx ?? f.px ?? 0)),
        };
      }
      if (status?.error) {
        return { ok: false, error: String(status.error) };
      }
      return { ok: false, error: "Unknown order response shape" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Cancel a single order by asset index + oid. */
  async cancelOrder(assetIndex: number, oid: number): Promise<boolean> {
    if (this.opts.dryRun) {
      this.opts.log.info({ assetIndex, oid }, "[DRY-RUN] Would cancel order");
      return true;
    }
    try {
      await this.exchange.cancel({ cancels: [{ a: assetIndex, o: oid }] });
      // Remove from tracking
      for (const [cid, mappedOid] of this.openOids.entries()) {
        if (mappedOid === oid) this.openOids.delete(cid);
      }
      return true;
    } catch (err) {
      this.opts.log.error({ err: (err as Error).message, oid }, "Cancel failed");
      return false;
    }
  }

  /** Emergency: cancel ALL of our open orders. */
  async cancelAll(): Promise<number> {
    const state = await this.getAccountState();
    const openOrders = (state as any)?.openOrders ?? [];
    if (this.opts.dryRun) {
      this.opts.log.warn({ count: openOrders.length }, "[DRY-RUN] Would cancel all");
      return openOrders.length;
    }
    let count = 0;
    for (const o of openOrders) {
      try {
        const assetIndex = this.resolveAsset(String(o.coin));
        await this.exchange.cancel({ cancels: [{ a: assetIndex, o: Number(o.oid) }] });
        count++;
      } catch (err) {
        this.opts.log.error({ err: (err as Error).message }, "cancelAll: skip one");
      }
    }
    this.openOids.clear();
    return count;
  }
}

/** Factory — checks for private key, returns LiveClient. */
export function createLiveClient(privateKey: string, log: Logger, dryRun = false): LiveClient {
  if (!privateKey || !privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error(
      "WALLET_PRIVATE_KEY must be a 0x-prefixed 64-char hex string. " +
        "Run `npm run gen-wallet` to generate a fresh one.",
    );
  }
  return new LiveClient({ privateKey: privateKey as `0x${string}`, log, dryRun });
}
