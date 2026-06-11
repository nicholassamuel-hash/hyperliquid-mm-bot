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

/** fetch with retry/backoff on 429 (HL info endpoint rate-limits bursts). */
async function fetchWithBackoff(input: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 6) return res;
    await sleep(1500 * attempt);
  }
}

/**
 * Dedupe by timestamp and infer each point's real settlement interval from
 * consecutive timestamp gaps (Bitget mixes 8h and 4h contracts; paginated
 * sources can also overlap). Assumes `fallbackHours` for the first point.
 */
export function normalizePoints(
  raw: Array<{ ts: number; rate: number }>,
  fallbackHours: number,
): FundingPoint[] {
  const byTs = new Map<number, number>();
  for (const r of raw) byTs.set(r.ts, r.rate);
  const sorted = [...byTs.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([ts, rate], i) => {
    let intervalHours = fallbackHours;
    if (i > 0) {
      const gapH = Math.round((ts - sorted[i - 1]![0]) / 3_600_000);
      if (gapH >= 1 && gapH <= 24) intervalHours = gapH;
    }
    return { ts, rate, intervalHours };
  });
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
  const raw: Array<{ ts: number; rate: number }> = [];
  let cursor = startMs;
  const endMs = Date.now();
  for (let page = 0; page < 60 && cursor < endMs; page++) {
    const res = await fetchWithBackoff("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin, startTime: cursor, endTime: endMs }),
    });
    if (!res.ok) throw new Error(`HL fundingHistory ${coin}: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ fundingRate: string; time: number }>;
    if (rows.length === 0) break;
    for (const r of rows) raw.push({ ts: r.time, rate: Number(r.fundingRate) });
    cursor = rows[rows.length - 1]!.time + 1;
    if (rows.length < 400) break; // last page
    await sleep(300); // be polite — HL rate-limits bursts
  }
  const out = normalizePoints(raw, 1);
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
  const raw: Array<{ ts: number; rate: number }> = [];
  let prevOldest = Infinity;
  for (let pageNo = 1; pageNo <= 60; pageNo++) {
    const url =
      `https://api.bitget.com/api/v2/mix/market/history-fund-rate` +
      `?symbol=${symbol}&productType=usdt-futures&pageSize=100&pageNo=${pageNo}`;
    const res = await fetchWithBackoff(url);
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
    let oldest = Infinity;
    for (const r of rows) {
      const ts = Number(r.fundingTime);
      if (ts < oldest) oldest = ts;
      if (ts < startMs) {
        reachedStart = true;
        continue;
      }
      raw.push({ ts, rate: Number(r.fundingRate) });
    }
    // Stop if the endpoint repeats data instead of paging further back.
    if (reachedStart || oldest >= prevOldest) break;
    prevOldest = oldest;
    await sleep(300);
  }
  // Interval inferred per-point: Bitget mixes 8h and 4h funding contracts.
  const out = normalizePoints(raw, 8);
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
