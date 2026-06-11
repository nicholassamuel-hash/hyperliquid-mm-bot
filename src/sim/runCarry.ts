/**
 * Funding-carry PAPER trader — delta-neutral long-spot + short-perp on
 * Hyperliquid, harvesting hourly funding. NO real orders, NO real money.
 *
 * Validated by the funding backtest (365d: HYPE 12.1% / ETH 7.3% / BTC 7.2%
 * net APR, always-in). This runner measures what the backtest could NOT:
 *   - real basis drift between the HL spot leg (HYPE, uBTC, uETH) and the perp
 *   - realized vs theoretical carry (execution leak detection)
 *
 * Design: REST polling only (funding settles hourly — no latency sensitivity).
 * Accruals are read from settled fundingHistory (restart-safe via
 * last_accrued_ts in data/carry.db). Guard: exit when the EWMA funding APR is
 * persistently negative, re-enter when it recovers (hysteresis).
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../util/logger.js";
import { CarryDB, type CarryLeg } from "../state/carryDb.js";
import { EwmaAprTracker } from "../research/carryPolicy.js";
import { fetchHyperliquidFunding } from "../research/fundingSources.js";

const INFO_URL = "https://api.hyperliquid.xyz/info";
/** HL spot token backing each perp coin (Unit-bridged assets + native HYPE). */
const SPOT_TOKEN: Record<string, string> = { HYPE: "HYPE", BTC: "UBTC", ETH: "UETH", SOL: "USOL" };

async function info<T>(body: object): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface PerpCtx {
  markPx: string;
  funding: string;
}
interface SpotUniverseEntry {
  name: string;
  tokens: [number, number];
  index: number;
}

/** Perp mark + current funding per coin. */
async function fetchPerpMarks(coins: string[]): Promise<Map<string, { mark: number; funding: number }>> {
  const [meta, ctxs] = await info<[{ universe: Array<{ name: string }> }, PerpCtx[]]>({
    type: "metaAndAssetCtxs",
  });
  const out = new Map<string, { mark: number; funding: number }>();
  meta.universe.forEach((u, i) => {
    if (coins.includes(u.name) && ctxs[i]) {
      out.set(u.name, { mark: Number(ctxs[i]!.markPx), funding: Number(ctxs[i]!.funding) });
    }
  });
  return out;
}

/** Spot mids for the backing tokens (vs USDC), keyed by perp coin name. */
async function fetchSpotMids(coins: string[]): Promise<Map<string, number>> {
  const [meta, ctxs] = await info<
    [{ tokens: Array<{ name: string; index: number }>; universe: SpotUniverseEntry[] }, Array<{ midPx: string | null }>]
  >({ type: "spotMetaAndAssetCtxs" });
  const tokenIdx = new Map<string, number>();
  for (const t of meta.tokens) tokenIdx.set(t.name, t.index);
  const usdc = tokenIdx.get("USDC");
  const out = new Map<string, number>();
  for (const coin of coins) {
    const base = tokenIdx.get(SPOT_TOKEN[coin] ?? "");
    if (base === undefined || usdc === undefined) continue;
    const pair = meta.universe.find((u) => u.tokens[0] === base && u.tokens[1] === usdc);
    if (!pair) continue;
    // ctxs align with universe[i].index, NOT the array position (verified live:
    // UBTC arrayPos=140 vs index=142 — array position gives a wrong market).
    const mid = Number(ctxs[pair.index]?.midPx);
    if (Number.isFinite(mid) && mid > 0) out.set(coin, mid);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const coins = cfg.CARRY_COINS.filter((c) => SPOT_TOKEN[c]);
  const oneWayCost = (cfg.CARRY_COST_RT_BPS / 2 / 1e4) * cfg.CARRY_NOTIONAL_USD;
  log.info(
    { coins, notionalUsd: cfg.CARRY_NOTIONAL_USD, exitApr: cfg.CARRY_EXIT_APR, reenterApr: cfg.CARRY_REENTER_APR },
    "Funding-carry paper trader starting",
  );
  log.warn("Paper mode: NO real orders, NO real money.");

  const db = new CarryDB("data/carry.db");
  const trackers = new Map<string, EwmaAprTracker>();

  // Warm the EWMA from the last 7 days of settled funding so the guard has
  // context immediately instead of cold-starting on one point.
  for (const coin of coins) {
    const tr = new EwmaAprTracker(cfg.CARRY_EWMA_HALFLIFE_H);
    try {
      const hist = await fetchHyperliquidFunding(coin, Date.now() - 7 * 86_400_000, false);
      for (const p of hist) tr.push(p.rate, p.intervalHours);
      log.info({ coin, ewmaApr: tr.value?.toFixed(4) }, "EWMA warmed from 7d history");
    } catch (err) {
      log.warn({ coin, err: (err as Error).message }, "EWMA warm-up failed — will warm from live accruals");
    }
    trackers.set(coin, tr);
  }

  const enter = (coin: string, spot: number, perp: number, now: number, existing?: CarryLeg) => {
    const leg: CarryLeg = {
      coin,
      status: "in",
      entryTs: now,
      entrySpot: spot,
      entryPerp: perp,
      notional: cfg.CARRY_NOTIONAL_USD,
      lastAccruedTs: existing?.lastAccruedTs ?? now,
      feesPaid: (existing?.feesPaid ?? 0) + oneWayCost,
    };
    db.upsertLeg(leg);
    db.recordEvent(coin, now, "enter", `spot=${spot} perp=${perp} cost=${oneWayCost.toFixed(4)}`);
    log.info({ coin, spot, perp }, "CARRY ENTER (paper: long spot + short perp)");
  };

  const exit = (coin: string, leg: CarryLeg, reason: string, now: number) => {
    db.upsertLeg({ ...leg, status: "out", feesPaid: leg.feesPaid + oneWayCost });
    db.recordEvent(coin, now, "exit", reason);
    log.warn({ coin, reason }, "CARRY EXIT (paper: both legs closed)");
  };

  const tick = async () => {
    const now = Date.now();
    let perps: Map<string, { mark: number; funding: number }>;
    let spots: Map<string, number>;
    try {
      [perps, spots] = await Promise.all([fetchPerpMarks(coins), fetchSpotMids(coins)]);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "tick: market fetch failed, skipping");
      return;
    }

    for (const coin of coins) {
      const perp = perps.get(coin);
      const spot = spots.get(coin);
      const tr = trackers.get(coin)!;
      let leg = db.getLeg(coin);

      // First sight of this coin → enter (always-on philosophy).
      if (!leg && perp && spot) {
        enter(coin, spot, perp.mark, now);
        leg = db.getLeg(coin);
      }
      if (!leg) continue;

      // Accrue any newly-settled funding intervals (restart-safe).
      if (leg.status === "in") {
        try {
          const settled = await fetchHyperliquidFunding(coin, leg.lastAccruedTs + 1, false);
          let accrued = 0;
          for (const p of settled) {
            const amount = leg.notional * p.rate;
            db.recordAccrual(coin, p.ts, p.rate, amount);
            tr.push(p.rate, p.intervalHours);
            accrued += amount;
            leg.lastAccruedTs = p.ts;
          }
          if (settled.length > 0) {
            db.upsertLeg(leg);
            log.info(
              { coin, intervals: settled.length, accruedUsd: accrued.toFixed(4), ewmaApr: tr.value?.toFixed(4) },
              "funding accrued",
            );
          }
        } catch (err) {
          log.warn({ coin, err: (err as Error).message }, "accrual fetch failed");
        }
      }

      // Basis snapshot — the hedge-quality measurement the backtest lacked.
      if (leg.status === "in" && perp && spot) {
        const basisBps = ((spot - perp.mark) / perp.mark) * 1e4;
        const spotPnl = (leg.notional / leg.entrySpot) * (spot - leg.entrySpot);
        const perpPnl = -(leg.notional / leg.entryPerp) * (perp.mark - leg.entryPerp);
        db.recordBasis(coin, now, spot, perp.mark, basisBps, spotPnl + perpPnl);
      }

      // Hysteresis guard on the EWMA funding forecast.
      const apr = tr.value;
      if (apr !== null) {
        if (leg.status === "in" && apr < cfg.CARRY_EXIT_APR) {
          exit(coin, leg, `ewma APR ${(apr * 100).toFixed(1)}% < ${(cfg.CARRY_EXIT_APR * 100).toFixed(0)}%`, now);
        } else if (leg.status === "out" && apr > cfg.CARRY_REENTER_APR && perp && spot) {
          enter(coin, spot, perp.mark, now, leg);
        }
      }
    }
  };

  await tick();
  setInterval(() => void tick(), cfg.CARRY_POLL_MS);

  // Periodic status line (separate cadence so logs stay readable).
  setInterval(() => {
    const s = db.summary();
    const perCoin: Record<string, unknown> = {};
    for (const l of s.legs) {
      const a = s.accr.find((x) => x.coin === l.coin);
      const b = s.lastBasis.find((x) => x.coin === l.coin);
      perCoin[l.coin] = {
        status: l.status,
        accrued: Number((a?.total ?? 0).toFixed(4)),
        fees: Number(l.feesPaid.toFixed(4)),
        basisPnl: Number((b?.basisPnl ?? 0).toFixed(4)),
        ewmaApr: Number((trackers.get(l.coin)?.value ?? 0).toFixed(4)),
      };
    }
    log.info({ ...perCoin }, "Carry periodic stats");
  }, 30 * 60_000);

  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
