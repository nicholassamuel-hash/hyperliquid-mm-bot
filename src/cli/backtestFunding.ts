/**
 * Funding-carry backtest — replays delta-neutral cash-and-carry policies over
 * real funding history from Hyperliquid (hourly) and/or Bitget (8h).
 *
 * Run:  npm run backtest:funding -- [--venue hyperliquid|bitget|both]
 *         [--coins BTC,ETH,SOL,HYPE] [--days 365] [--costBps 30] [--notional 1000]
 *
 * NOTE: api.bitget.com is DNS-blocked on some Indonesian ISPs — run on the VPS.
 * Honest framing: this replays FUNDING ONLY. It assumes the spot hedge tracks
 * the perp perfectly (no basis PnL) and fills at costRtBps. Real-world slippage,
 * spot-perp basis drift, and venue risk are NOT modelled — treat results as an
 * upper bound and stress costBps upward.
 */
import { fetchFunding, type Venue } from "../research/fundingSources.js";
import { replayCarry, POLICY_GRID, annualize } from "../research/carryPolicy.js";

const color = (s: string, c: string) => `\x1b[${c}m${s}\x1b[0m`;
const bold = (s: string) => color(s, "1");
const green = (s: string) => color(s, "32");
const red = (s: string) => color(s, "31");
const yellow = (s: string) => color(s, "33");
const cyan = (s: string) => color(s, "36");
const dim = (s: string) => color(s, "2");

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

function pct(x: number): string {
  const s = `${(x * 100).toFixed(1)}%`;
  return x > 0.005 ? green(s) : x < -0.005 ? red(s) : dim(s);
}

async function main() {
  const venueArg = arg("venue", "both");
  const coins = arg("coins", "BTC,ETH,SOL,HYPE").split(",").map((c) => c.trim().toUpperCase());
  const days = parseInt(arg("days", "365"), 10);
  const costRtBps = Number(arg("costBps", "30"));
  const notional = Number(arg("notional", "1000"));
  const startMs = Date.now() - days * 86_400_000;
  const venues: Venue[] =
    venueArg === "both" ? ["hyperliquid", "bitget"] : [venueArg as Venue];

  console.log("");
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════════════════")));
  console.log(bold(cyan(`  Funding-carry backtest — ${days}d lookback, cost ${costRtBps}bp RT, notional $${notional}`)));
  console.log(bold(cyan("═══════════════════════════════════════════════════════════════════════════════")));
  console.log(dim("  Funding-only replay: no basis PnL, no slippage beyond costBps. Upper bound."));
  console.log("");

  for (const venue of venues) {
    console.log(bold(`▌ ${venue.toUpperCase()}`));
    for (const coin of coins) {
      let pts;
      try {
        pts = await fetchFunding(venue, coin, startMs);
      } catch (err) {
        console.log(`  ${coin.padEnd(6)} ${red("fetch failed:")} ${(err as Error).message}`);
        continue;
      }
      if (pts.length < 10) {
        console.log(`  ${coin.padEnd(6)} ${yellow(`only ${pts.length} funding points — skipped`)}`);
        continue;
      }
      const spanD = (pts[pts.length - 1]!.ts - pts[0]!.ts) / 86_400_000;
      const avgApr =
        pts.reduce((s, p) => s + annualize(p.rate, p.intervalHours), 0) / pts.length;
      const posShare = pts.filter((p) => p.rate > 0).length / pts.length;
      console.log(
        bold(`  ${coin}`) +
          dim(
            `  (${pts.length} pts, ${spanD.toFixed(0)}d, raw avg funding ${(avgApr * 100).toFixed(1)}% APR, positive ${(posShare * 100).toFixed(0)}% of intervals)`,
          ),
      );
      for (const pol of POLICY_GRID) {
        const res = replayCarry(pts, {
          thetaInApr: pol.thetaInApr,
          thetaOutApr: pol.thetaOutApr,
          ewmaHalfLifeHours: 72,
          costRtBps,
          notional,
        });
        console.log(
          `    ${pol.name.padEnd(20)} ` +
            `netAPR=${pct(res.aprNet).padStart(15)}  ` +
            `grossAPR=${pct(res.aprGross).padStart(15)}  ` +
            `util=${(res.utilization * 100).toFixed(0).padStart(3)}%  ` +
            `RTs=${String(res.exits).padStart(3)}  ` +
            `maxDD=$${res.maxDrawdown.toFixed(2).padStart(7)}  ` +
            `worstNegStreak=${res.worstNegStreakHours.toFixed(0)}h`,
        );
      }
      console.log("");
    }
  }

  console.log(bold("🧭 HOW TO READ"));
  console.log(dim("  - netAPR on $" + notional + " notional; scale linearly. always-in = structural baseline."));
  console.log(dim("  - If a thresholded policy beats always-in net, hysteresis earns its fees."));
  console.log(dim("  - Stress test: re-run with --costBps 60 — if netAPR survives, the edge is robust."));
  console.log(dim("  - maxDD here is funding-only; real DD adds basis noise on top."));
  console.log("");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
