/**
 * Terminal dashboard — reads from data/bot.db and displays live stats.
 *
 * Run: npm run dashboard
 *
 * Refreshes every 1s. Press Ctrl+C to exit.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.resolve("data/bot.db");
const REFRESH_MS = 1000;

interface Stats {
  fills: number;
  totalFees: number;
  buyNotional: number;
  sellNotional: number;
}

interface Outcomes {
  placed: number;
  cancelled_adverse: number;
  cancelled_skip: number;
  noop: number;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function moveCursor(row: number, col: number) {
  process.stdout.write(`\x1b[${row};${col}H`);
}

function color(s: string, code: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

function bold(s: string) {
  return color(s, "1");
}
function green(s: string) {
  return color(s, "32");
}
function red(s: string) {
  return color(s, "31");
}
function yellow(s: string) {
  return color(s, "33");
}
function cyan(s: string) {
  return color(s, "36");
}
function dim(s: string) {
  return color(s, "2");
}

function pnlColor(n: number, s: string) {
  return n > 0 ? green(s) : n < 0 ? red(s) : yellow(s);
}

function fmt(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

function render(db: DatabaseSync, startTs: number) {
  const stats = db
    .prepare(
      `SELECT
            COUNT(*) AS fills,
            COALESCE(SUM(CASE WHEN side='SELL' THEN size*price ELSE 0 END), 0) AS sellNotional,
            COALESCE(SUM(CASE WHEN side='BUY' THEN size*price ELSE 0 END), 0) AS buyNotional,
            COALESCE(SUM(fee), 0) AS totalFees
         FROM fills WHERE ts >= ?`,
    )
    .get(startTs) as unknown as Stats;

  const outcomeRows = db
    .prepare(`SELECT outcome, COUNT(*) AS n FROM outcomes WHERE ts >= ? GROUP BY outcome`)
    .all(startTs) as Array<{ outcome: string; n: number }>;
  const outcomes: Outcomes = {
    placed: 0,
    cancelled_adverse: 0,
    cancelled_skip: 0,
    noop: 0,
  };
  for (const r of outcomeRows) {
    if (r.outcome in outcomes) {
      (outcomes as any)[r.outcome] = r.n;
    }
  }

  const fillRate =
    outcomes.placed > 0 ? (stats.fills / outcomes.placed) * 100 : 0;
  const adverseRate =
    outcomes.placed > 0 ? (outcomes.cancelled_adverse / outcomes.placed) * 100 : 0;

  // Estimated unrealized — would need position table; for now just notional
  const netNotional = stats.sellNotional - stats.buyNotional;

  const recentFills = db
    .prepare(
      `SELECT coin, side, price, size, fee, ts FROM fills ORDER BY ts DESC LIMIT 8`,
    )
    .all() as Array<{
    coin: string;
    side: string;
    price: number;
    size: number;
    fee: number;
    ts: number;
  }>;

  clearScreen();
  moveCursor(1, 1);

  console.log(bold(cyan("┌─────────────────────────────────────────────────────────────────┐")));
  console.log(bold(cyan("│ Hyperliquid MM Bot — Dashboard                                  │")));
  console.log(bold(cyan("└─────────────────────────────────────────────────────────────────┘")));

  console.log("");
  console.log(bold("ACTIVITY"));
  console.log(
    `  Quotes placed:           ${bold(String(outcomes.placed).padStart(8))}`,
  );
  console.log(
    `  Cancelled (adverse):     ${bold(yellow(String(outcomes.cancelled_adverse).padStart(8)))}`,
  );
  console.log(
    `  Cancelled (skip):        ${bold(dim(String(outcomes.cancelled_skip).padStart(8)))}`,
  );
  console.log(`  Fills:                   ${bold(green(String(stats.fills).padStart(8)))}`);

  console.log("");
  console.log(bold("RATES"));
  console.log(`  Fill rate:               ${bold(fillRate.toFixed(2).padStart(7) + "%")}`);
  console.log(
    `  Adverse rate:            ${bold(yellow(adverseRate.toFixed(2).padStart(7) + "%"))}`,
  );

  console.log("");
  console.log(bold("VOLUME & PNL"));
  console.log(`  Sell notional:           ${fmt(stats.sellNotional, 4).padStart(12)}`);
  console.log(`  Buy notional:            ${fmt(stats.buyNotional, 4).padStart(12)}`);
  console.log(
    `  Net notional:            ${pnlColor(netNotional, fmt(netNotional, 4).padStart(12))}`,
  );
  console.log(`  Total fees (paid):       ${red(fmt(stats.totalFees, 6).padStart(14))}`);

  console.log("");
  console.log(bold("RECENT FILLS (last 8)"));
  if (recentFills.length === 0) {
    console.log(dim("  (none yet)"));
  } else {
    for (const f of recentFills) {
      const sideC = f.side === "BUY" ? green(f.side) : red(f.side);
      const time = new Date(f.ts).toISOString().substr(11, 8);
      console.log(
        `  ${dim(time)}  ${f.coin.padEnd(6)} ${sideC.padEnd(20)} ${String(f.price).padStart(10)} × ${String(f.size).padStart(8)}`,
      );
    }
  }

  console.log("");
  console.log(dim(`  (refresh ${REFRESH_MS}ms, Ctrl+C to exit)`));
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Start the bot first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const startTs = Date.now() - 24 * 3600 * 1000; // last 24h

  const tick = () => {
    try {
      render(db, startTs);
    } catch (err) {
      console.error("Render error:", (err as Error).message);
    }
  };
  tick();
  const interval = setInterval(tick, REFRESH_MS);

  const shutdown = () => {
    clearInterval(interval);
    db.close();
    clearScreen();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
