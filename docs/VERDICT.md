# VERDICT / Decision Log — Hyperliquid Auction-Reversion Bot

## 2026-06-09 — STOPPED (then reopened, see below)

After ~82h paper trading across all auction versions (v4-maker → v5 max-config),
the reversion strategy showed **no edge** on Hyperliquid mainstream perp at retail
tier. Cumulative read (FIFO-reconstructed from 353 fills in `data/auction.db`):

| Metric | Value |
|---|---|
| Span | 82.6h, 353 fills, 180 round-trips |
| Gross PnL | **−$0.53** (price-only, before fees) |
| Fees | −$0.78 |
| **Net** | **−$1.31** |
| Win rate | 34.4% (62 W / 118 L) |
| Avg per RT | −$0.0029 (≈ −5.8 bps @ $5 notional) |
| Per coin (gross) | BTC −0.07, ETH −0.19, SOL −0.05, HYPE −0.22 — all negative |

So not even "flat" — the larger sample shows mildly-negative gross (~−5.8bp/RT);
earlier "flat" reads were small-sample noise. Trailing exit gives nice right-skew
(best +3.1% vs stop −1.5%) but 34% hit-rate can't cover it = no directional edge.
Taker fees on exits (stops cross book @ 4.5bp) ≈ 148% of |gross| double the bleed.
Same structural wall as the MM bot, both sides of the coin.

## 2026-06-10 — REOPENED with instrumentation (don't blind-tune)

We were **blind**: the `outcomes` table was empty and PnL was only ever an aggregate
net — so "no edge" was inferred from a single number, never sliced. Before declaring
the signal dead for good, the honest move is to *see where* it wins/loses.

Added (logging-only, **zero change to trading logic**):
- `trades` table — one row per closed round-trip with **entry-time context**
  (regime/VWAP-slope, RVOL, trigger band-vs-trapped, entry/exit reason) and
  **gross separated from fees** (the edge vs the drag).
- `npm run analyze:auction [hours]` — slices WR / gross / net / gross-bps by
  **regime, exit reason, trigger, coin, side**, with a gross-keyed read.
- `recordOutcome` is now actually called (it never was), so `outcomes` populates too.

**Decision rule for the next read** (keyed on GROSS, not net):
- One regime is +gross while others bleed → **gate to it** (real, data-driven edge).
- Gross uniformly ≈flat/negative across all regimes (50+ RT) → **edge confirmed
  absent → pivot** to funding-harvest / niche (small) coins / HLP vault. Do NOT
  keep tuning reversion params — that's the MM trap.

Process re-running on the VPS (PM2 `auction`, paper, no real money).
