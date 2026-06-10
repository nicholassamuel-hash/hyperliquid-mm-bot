/**
 * Auction-strategy trade analysis — slices the per-round-trip `trades` table so
 * the "is there an edge, and WHERE" question is answerable instead of one blind
 * net PnL. Separates GROSS (price-only = the edge) from FEES (the drag).
 *
 * Run: npm run analyze:auction [hours_lookback]   (default: all history)
 *
 * Needs the instrumented bot (records `trades` rows) to have run — older runs
 * only have raw `fills`, so a fresh table starts empty until trades close.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.resolve("data/auction.db");
const HOURS = process.argv[2] ? parseInt(process.argv[2], 10) : 0; // 0 = all

const color = (s: string, c: string) => `\x1b[${c}m${s}\x1b[0m`;
const bold = (s: string) => color(s, "1");
const green = (s: string) => color(s, "32");
const red = (s: string) => color(s, "31");
const yellow = (s: string) => color(s, "33");
const cyan = (s: string) => color(s, "36");
const dim = (s: string) => color(s, "2");

function usd(n: number): string {
  const s = `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;
  return n > 0 ? green(s) : n < 0 ? red(s) : dim(s);
}

interface Row {
  coin: string;
  side: string;
  trigger: string;
  regime: string;
  exitReason: string;
  notional: number;
  gross: number;
  fee: number;
  net: number;
  holdMs: number;
}

interface Agg {
  n: number;
  wins: number;
  gross: number;
  fee: number;
  net: number;
  notional: number;
}

function agg(rows: Row[]): Agg {
  const a: Agg = { n: 0, wins: 0, gross: 0, fee: 0, net: 0, notional: 0 };
  for (const r of rows) {
    a.n++;
    if (r.gross > 0) a.wins++;
    a.gross += r.gross;
    a.fee += r.fee;
    a.net += r.net;
    a.notional += r.notional;
  }
  return a;
}

/** Average gross in bps of notional — the size-normalised edge per round-trip. */
function grossBps(a: Agg): number {
  return a.notional > 0 ? (a.gross / a.notional) * 1e4 : 0;
}

function line(label: string, a: Agg): string {
  const wr = a.n > 0 ? (100 * a.wins) / a.n : 0;
  const bps = grossBps(a);
  const bpsStr = `${bps >= 0 ? "+" : ""}${bps.toFixed(1)}bp`;
  const bpsColored = bps > 0.3 ? green(bpsStr) : bps < -0.3 ? red(bpsStr) : dim(bpsStr);
  return (
    `  ${label.padEnd(34)} ` +
    `n=${String(a.n).padStart(4)}  ` +
    `WR=${wr.toFixed(0).padStart(3)}%  ` +
    `gross=${usd(a.gross).padStart(20)}  ` +
    `net=${usd(a.net).padStart(20)}  ` +
    `grossBp=${bpsColored}`
  );
}

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

function section(title: string, rows: Row[], key: (r: Row) => string) {
  console.log(bold(title));
  const groups = [...groupBy(rows, key).entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [k, rs] of groups) console.log(line(k, agg(rs)));
  console.log("");
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No auction.db at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const hasTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='trades'`)
    .get();
  if (!hasTable) {
    console.log(yellow("No `trades` table yet — the instrumented bot hasn't closed any round-trips."));
    console.log(dim("Deploy the instrumented build, let it bake, then re-run."));
    db.close();
    return;
  }

  const sinceMs = HOURS > 0 ? Date.now() - HOURS * 3600_000 : 0;
  const rows = db
    .prepare(
      `SELECT coin, side, trigger, regime, exit_reason AS exitReason,
              notional, gross, fee, net, hold_ms AS holdMs
       FROM trades WHERE ts >= ? ORDER BY ts ASC`,
    )
    .all(sinceMs) as unknown as Row[];

  const span = HOURS > 0 ? `last ${HOURS}h` : "all history";
  console.log("");
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════════════")));
  console.log(bold(cyan(`  Auction trades — edge breakdown (${span})`)));
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════════════")));
  console.log("");

  if (rows.length === 0) {
    console.log(yellow("  No closed round-trips in window yet. Let it bake."));
    console.log("");
    db.close();
    return;
  }

  const all = agg(rows);
  const avgHoldMin = rows.reduce((s, r) => s + r.holdMs, 0) / rows.length / 60_000;

  console.log(bold("📊 OVERALL"));
  console.log(line("all trades", all));
  console.log(
    dim(
      `  avg hold=${avgHoldMin.toFixed(1)}min  fees=${red(`$${all.fee.toFixed(4)}`)}  ` +
        `fees as % of |gross|=${all.gross !== 0 ? Math.round((all.fee / Math.abs(all.gross)) * 100) : 0}%`,
    ),
  );
  console.log("");

  section("🌊 BY REGIME (entry-time VWAP slope)", rows, (r) => r.regime);
  section("🎯 BY EXIT REASON", rows, (r) => r.exitReason);
  section("🔑 BY TRIGGER", rows, (r) => r.trigger);
  section("🪙 BY COIN", rows, (r) => r.coin);
  section("↕ BY SIDE", rows, (r) => r.side);

  // === HONEST VERDICT (keyed on GROSS — the edge, not the fees) ===
  console.log(bold("🧭 READ"));
  const bps = grossBps(all);
  if (all.n < 30) {
    console.log(yellow(`  ~ Only ${all.n} round-trips — too few to trust. Keep baking (aim 50+).`));
  } else if (bps > 0.5) {
    console.log(green(`  ✓ Gross edge POSITIVE (${bps.toFixed(1)}bp/RT). Check which regime drives it ↑ — that's the keeper.`));
  } else if (bps < -0.5) {
    console.log(red(`  ✗ Gross edge NEGATIVE (${bps.toFixed(1)}bp/RT) — signal predicts the wrong way. Tuning won't fix sign.`));
    console.log(dim("    Look at BY REGIME: if one regime is +gross and others bleed, gate to it. Else pivot."));
  } else {
    console.log(yellow(`  ~ Gross ≈ FLAT (${bps.toFixed(1)}bp/RT) — no directional edge; loss is just fees. Pivot, don't tune.`));
  }
  console.log("");
  console.log(dim(`  ${all.n} round-trips | generated ${new Date().toISOString()}`));
  console.log("");

  db.close();
}

main();
