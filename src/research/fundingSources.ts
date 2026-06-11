/**
 * Funding-rate history fetchers, normalized across venues.
 *
 * Both venues expose PUBLIC endpoints (no auth):
 *   - Hyperliquid: POST /info {type:"fundingHistory"} — hourly rates, paginated
 *     by startTime (~500 rows per response).
 *   - Bitget: GET /api/v2/mix/market/history-fund-rate — 8-hour rates, paginated
 *     by pageNo (100 rows per page).
 *
 * Sign convention (both venues): positive rate → longs pay shorts. A short-perp
 * carry position RECEIVES positive funding.
 *
 * NOTE: api.bitget.com is DNS-blocked on some Indonesian ISPs — run fetches on
 * the VPS if local resolution fails.
 */
import fs from "node:fs";
import path from "node:path";

export interface FundingPoint {
  ts: number; // settlement time (ms)
  rate: number; // rate per interval (decimal, e.g. 0.0000125 = 0.00125%)
  intervalHours: number; // 1 (Hyperliquid) or 8 (Bitget)
}

const CACHE_DIR = "data/funding";

function cachePath(venue: string, coin: string): string {
  return path.join(CACHE_DIR, `${venue}-${coin}.json`);
}

function readCache(venue: string, coin: string): FundingPoint[] | null {
  const p = cachePath(venue, coin);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as FundingPoint[];
  } catch {
    return null;
  }
}

function writeCache(venue: string, coin: string, points: FundingPoint[]) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(venue, coin), JSON.stringify(points));
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Hyperliquid hourly funding history for `coin` since `startMs`. */
export async function fetchHyperliquidFunding(
  coin: string,
  startMs: number,
  useCache = true,
): Promise<FundingPoint[]> {
  if (useCache) {
    const c = readCache("hyperliquid", coin);
    if (c && c.length > 0 && c[0]!.ts <= startMs + 86_400_000) return c.filter((p) => p.ts >= startMs);
  }
  const out: FundingPoint[] = [];
  let cursor = startMs;
  const endMs = Date.now();
  for (let page = 0; page < 60 && cursor < endMs; page++) {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin, startTime: cursor, endTime: endMs }),
    });
    if (!res.ok) throw new Error(`HL fundingHistory ${coin}: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ fundingRate: string; time: number }>;
    if (rows.length === 0) break;
    for (const r of rows) out.push({ ts: r.time, rate: Number(r.fundingRate), intervalHours: 1 });
    cursor = rows[rows.length - 1]!.time + 1;
    if (rows.length < 400) break; // last page
    await sleep(150); // be polite
  }
  out.sort((a, b) => a.ts - b.ts);
  writeCache("hyperliquid", coin, out);
  return out;
}

/** Bitget 8-hour funding history for `coin` (USDT-margined perp) since `startMs`. */
export async function fetchBitgetFunding(
  coin: string,
  startMs: number,
  useCache = true,
): Promise<FundingPoint[]> {
  if (useCache) {
    const c = readCache("bitget", coin);
    if (c && c.length > 0 && c[0]!.ts <= startMs + 8 * 86_400_000) return c.filter((p) => p.ts >= startMs);
  }
  const symbol = `${coin}USDT`;
  const out: FundingPoint[] = [];
  for (let pageNo = 1; pageNo <= 60; pageNo++) {
    const url =
      `https://api.bitget.com/api/v2/mix/market/history-fund-rate` +
      `?symbol=${symbol}&productType=usdt-futures&pageSize=100&pageNo=${pageNo}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bitget history-fund-rate ${symbol}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      code: string;
      msg: string;
      data: Array<{ fundingRate: string; fundingTime: string }> | null;
    };
    if (body.code !== "00000") throw new Error(`Bitget ${symbol}: ${body.msg}`);
    const rows = body.data ?? [];
    if (rows.length === 0) break;
    let reachedStart = false;
    for (const r of rows) {
      const ts = Number(r.fundingTime);
      if (ts < startMs) {
        reachedStart = true;
        continue;
      }
      out.push({ ts, rate: Number(r.fundingRate), intervalHours: 8 });
    }
    if (reachedStart) break;
    await sleep(150);
  }
  out.sort((a, b) => a.ts - b.ts);
  writeCache("bitget", coin, out);
  return out;
}

export type Venue = "hyperliquid" | "bitget";

export async function fetchFunding(
  venue: Venue,
  coin: string,
  startMs: number,
  useCache = true,
): Promise<FundingPoint[]> {
  return venue === "hyperliquid"
    ? fetchHyperliquidFunding(coin, startMs, useCache)
    : fetchBitgetFunding(coin, startMs, useCache);
}
