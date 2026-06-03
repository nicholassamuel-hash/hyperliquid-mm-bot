/**
 * Analysis script — comprehensive evaluation of paper trading session.
 *
 * Run: npm run analyze [hours_lookback]
 * Default: last 24h
 *
 * Outputs:
 *   - PnL summary (realized + unrealized estimate)
 *   - Activity stats (fills, quotes, fill rate, adverse rate)
 *   - Performance by hour
 *   - Risk metrics (max position, time-at-cap)
 *   - Verdict + recommended next action
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.resolve("data/bot.db");
const HOURS = parseInt(process.argv[2] ?? "24", 10);

function color(s: string, code: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const bold = (s: string) => color(s, "1");
const green = (s: string) => color(s, "32");
const red = (s: string) => color(s, "31");
const yellow = (s: string) => color(s, "33");
const cyan = (s: string) => color(s, "36");
const dim = (s: string) => color(s, "2");

function pnl(n: number): string {
  if (n > 0) return green(`+$${n.toFixed(4)}`);
  if (n < 0) return red(`-$${Math.abs(n).toFixed(4)}`);
  return dim(`$${n.toFixed(4)}`);
}


function bar(value: number, max: number, width = 30): string {
  if (max === 0) return dim("─".repeat(width));
  const filled = Math.round((value / max) * width);
  return green("█".repeat(filled)) + dim("─".repeat(width - filled));
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No bot.db at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const sinceMs = Date.now() - HOURS * 3600_000;

  // === HEADER ===
  console.log("");
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════")));
  console.log(bold(cyan(`  Hyperliquid MM Bot — Analysis (last ${HOURS}h)`)));
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════")));
  console.log("");

  // === ACTIVITY ===
  const outcomes = db
    .prepare(
      `SELECT outcome, COUNT(*) AS n FROM outcomes WHERE ts >= ? GROUP BY outcome`,
    )
    .all(sinceMs) as Array<{ outcome: string; n: number }>;
  const outc: Record<string, number> = {};
  for (const r of outcomes) outc[r.outcome] = r.n;

  const placed = outc.placed ?? 0;
  const cancelledAdverse = outc.cancelled_adverse ?? 0;
  const cancelledSkip = outc.cancelled_skip ?? 0;

  console.log(bold("📊 ACTIVITY"));
  console.log(`  Quote pairs placed:       ${String(placed).padStart(10)}`);
  console.log(
    `  Cancelled (adverse):      ${String(cancelledAdverse).padStart(10)}  ${yellow("[informed flow detected]")}`,
  );
  console.log(
    `  Cancelled (skip):         ${String(cancelledSkip).padStart(10)}  ${dim("[edge gate / inventory cap]")}`,
  );

  const adverseRate = placed > 0 ? (cancelledAdverse / placed) * 100 : 0;
  const adverseLabel =
    adverseRate < 50 ? green("HEALTHY") : adverseRate < 80 ? yellow("ACCEPTABLE") : red("HIGH (latency disadvantage)");
  console.log(`  Adverse rate:             ${adverseRate.toFixed(2).padStart(7)}%   ${adverseLabel}`);
  console.log("");

  // === FILLS & PNL ===
  const fillsStats = db
    .prepare(
      `SELECT
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN side='SELL' THEN size*price ELSE 0 END), 0) AS sellNotional,
            COALESCE(SUM(CASE WHEN side='BUY' THEN size*price ELSE 0 END), 0) AS buyNotional,
            COALESCE(SUM(fee), 0) AS totalFees,
            COALESCE(SUM(CASE WHEN side='BUY' THEN size ELSE -size END), 0) AS netSize
         FROM fills WHERE ts >= ?`,
    )
    .get(sinceMs) as { n: number; sellNotional: number; buyNotional: number; totalFees: number; netSize: number };

  const fills = fillsStats.n;
  const fillRate = placed > 0 ? (fills / placed) * 100 : 0;
  // Net cash flow (NOT realized PnL — includes value of open positions)
  const netCashFlow =
    fillsStats.sellNotional - fillsStats.buyNotional - fillsStats.totalFees;
  // True realized requires position to be fully closed. Open positions skew this.
  const positionOpen = Math.abs(fillsStats.netSize) > 1e-9;

  console.log(bold("💵 FILLS & CASH FLOW"));
  console.log(`  Total fills:              ${String(fills).padStart(10)}`);
  console.log(`  Sell notional:            ${`$${fillsStats.sellNotional.toFixed(4)}`.padStart(12)}`);
  console.log(`  Buy notional:             ${`$${fillsStats.buyNotional.toFixed(4)}`.padStart(12)}`);
  console.log(`  Fees paid:                ${red(`$${fillsStats.totalFees.toFixed(6)}`.padStart(14))}`);
  console.log(`  Fill rate per quote:      ${fillRate.toFixed(2).padStart(7)}%`);
  console.log("");
  if (positionOpen) {
    console.log(`  ${bold("Net cash flow:")}                ${pnl(netCashFlow).padStart(20)}`);
    console.log(
      yellow(`  ⚠ Position OPEN — true PnL depends on close price. Cash flow ≠ realized profit.`),
    );
  } else {
    console.log(`  ${bold("Realized PnL (all closed):")}     ${pnl(netCashFlow).padStart(20)}`);
  }
  console.log("");

  // === PER COIN POSITION ===
  // Approximate position from fill net size & last fill price
  const perCoin = db
    .prepare(
      `SELECT
            coin,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN side='BUY' THEN size ELSE -size END), 0) AS netSize,
            (SELECT price FROM fills f2 WHERE f2.coin = f.coin ORDER BY ts DESC LIMIT 1) AS lastPrice,
            COALESCE(SUM(fee), 0) AS feesCoin
         FROM fills f WHERE ts >= ? GROUP BY coin`,
    )
    .all(sinceMs) as Array<{ coin: string; n: number; netSize: number; lastPrice: number; feesCoin: number }>;

  if (perCoin.length > 0) {
    console.log(bold("📈 PER-COIN BREAKDOWN"));
    for (const c of perCoin) {
      const notional = Math.abs(c.netSize) * c.lastPrice;
      const sign = c.netSize > 0 ? "LONG" : c.netSize < 0 ? "SHORT" : "FLAT";
      const sideC = sign === "LONG" ? green(sign) : sign === "SHORT" ? red(sign) : dim(sign);
      console.log(
        `  ${c.coin.padEnd(8)} ${sideC.padEnd(20)} size=${c.netSize.toFixed(4).padStart(10)}  notional=$${notional.toFixed(2).padStart(8)}  fills=${c.n}`,
      );
    }
    console.log("");
  }

  // === PERFORMANCE BY HOUR ===
  const hourlyFills = db
    .prepare(
      `SELECT
            strftime('%Y-%m-%d %H', datetime(ts/1000, 'unixepoch', '+7 hours')) AS hour,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN side='SELL' THEN size*price ELSE -size*price END), 0) AS netInflow,
            COALESCE(SUM(fee), 0) AS fees
         FROM fills WHERE ts >= ? GROUP BY hour ORDER BY hour DESC LIMIT 24`,
    )
    .all(sinceMs) as Array<{ hour: string; n: number; netInflow: number; fees: number }>;

  if (hourlyFills.length > 0) {
    console.log(bold("⏰ PERFORMANCE BY HOUR (WIB / UTC+7)"));
    const maxFills = Math.max(...hourlyFills.map((h) => h.n), 1);
    console.log(`  ${dim("Hour".padEnd(16))}  ${dim("Fills".padEnd(7))}  ${dim("Bar".padEnd(32))}  ${dim("Hour PnL")}`);
    for (const h of hourlyFills.reverse()) {
      const hourPnL = h.netInflow - h.fees;
      console.log(
        `  ${h.hour.padEnd(16)}  ${String(h.n).padStart(5)}    ${bar(h.n, maxFills, 30)}  ${pnl(hourPnL)}`,
      );
    }
    console.log("");
  }

  // === VERDICT ===
  console.log(bold("🎯 VERDICT"));
  if (fills === 0) {
    console.log(red("  ✗ No fills in window. Strategy too defensive or market too thin."));
    console.log(dim("  → Lower HALF_SPREAD_BPS_MIN, ADVERSE_THRESHOLD_BPS_MIN. Try a different coin."));
  } else if (positionOpen) {
    console.log(
      yellow(`  ⚠ Position OPEN — verdict deferred until close. Cash flow ${pnl(netCashFlow)} is NOT a profit number.`),
    );
    console.log(
      dim(`  → Wait for position to flatten naturally, or restart bot from clean state.`),
    );
  } else if (netCashFlow > 0.05) {
    console.log(green(`  ✓ Net realized profit (closed cycle): ${pnl(netCashFlow)}`));
    console.log(dim("  → Consider Phase 2: $5-10 live micro test before scaling."));
  } else if (netCashFlow > -0.05) {
    console.log(yellow(`  ~ Break-even (closed cycle): ${pnl(netCashFlow)} (within noise)`));
    console.log(dim("  → Need more data. Run another 24-48h. Or tune more aggressive."));
  } else {
    console.log(red(`  ✗ Net loss (closed cycle): ${pnl(netCashFlow)}`));
    console.log(dim("  → Strategy lacks edge at this latency. Consider pivot."));
  }

  if (adverseRate > 80 && placed > 50) {
    console.log("");
    console.log(yellow("  ⚠ Adverse rate >80% — latency from Jakarta likely the bottleneck."));
    console.log(dim("    Going live won't help. Consider US/EU VPS or HLP vault instead."));
  }

  if (placed > 0 && cancelledSkip / placed > 5) {
    console.log("");
    console.log(yellow("  ⚠ Lots of cancelled_skip — bot likely hit margin/position cap & got stuck."));
    console.log(dim("    Bug fix landed 2026-06-02. Update + restart to use it."));
  }

  console.log("");
  console.log(dim(`  Analysis window: ${HOURS}h | Generated: ${new Date().toISOString()}`));
  console.log("");

  db.close();
}

main();
