/**
 * Carry paper-bot report — realized funding vs fees vs basis drift, per coin.
 * Run on the VPS: npm run carry:report
 */
import { CarryDB } from "../state/carryDb.js";

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

function main() {
  const db = new CarryDB("data/carry.db");
  const s = db.summary();

  console.log("");
  console.log(bold(cyan("══════════════════════════════════════════════════════════════════════")));
  console.log(bold(cyan("  Funding-carry paper bot — realized report")));
  console.log(bold(cyan("══════════════════════════════════════════════════════════════════════")));
  console.log("");

  if (s.legs.length === 0) {
    console.log(yellow("  No positions yet — bot hasn't run."));
    db.close();
    return;
  }

  let totAccrued = 0;
  let totFees = 0;
  let totBasis = 0;
  for (const l of s.legs) {
    const a = s.accr.find((x) => x.coin === l.coin);
    const b = s.lastBasis.find((x) => x.coin === l.coin);
    const accrued = a?.total ?? 0;
    const basisPnl = b?.basisPnl ?? 0;
    const net = accrued - l.feesPaid + basisPnl;
    totAccrued += accrued;
    totFees += l.feesPaid;
    totBasis += basisPnl;
    const spanDays = a ? (a.lastTs - a.firstTs) / 86_400_000 : 0;
    const aprRealized = spanDays > 0.04 ? accrued / l.notional / (spanDays / 365) : 0;
    console.log(
      bold(`  ${l.coin.padEnd(6)}`) +
        `${l.status === "in" ? green("IN ") : yellow("OUT")}  ` +
        `accrued=${usd(accrued).padStart(18)} (${a?.n ?? 0} intervals)  ` +
        `fees=${red(`$${l.feesPaid.toFixed(4)}`)}  ` +
        `basisPnl=${usd(basisPnl).padStart(18)}  ` +
        `net=${usd(net).padStart(18)}`,
    );
    console.log(
      dim(
        `         realized APR=${(aprRealized * 100).toFixed(1)}% over ${spanDays.toFixed(1)}d` +
          (b ? ` | basis now=${b.basisBps.toFixed(1)}bp` : ""),
      ),
    );
  }

  console.log("");
  console.log(
    bold("  TOTAL  ") +
      `accrued=${usd(totAccrued)}  fees=${red(`$${totFees.toFixed(4)}`)}  basis=${usd(totBasis)}  ` +
      bold(`net=${usd(totAccrued - totFees + totBasis)}`),
  );

  if (s.events.length > 0) {
    console.log("");
    console.log(bold("  Recent events"));
    for (const e of s.events.slice(0, 8)) {
      console.log(dim(`    ${new Date(e.ts).toISOString()}  ${e.coin.padEnd(5)} ${e.type.padEnd(6)} ${e.detail}`));
    }
  }
  console.log("");
  console.log(dim(`  Backtest expectation (always-in, net): HYPE ~12%, ETH ~7.3%, BTC ~7.2% APR.`));
  console.log(dim(`  If realized APR tracks it and basisPnl stays small → the edge survives execution.`));
  console.log("");
  db.close();
}

main();
