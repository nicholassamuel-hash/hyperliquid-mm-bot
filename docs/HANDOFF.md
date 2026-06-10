# Project Handoff — Hyperliquid Auction Bot (v5 "max-config")

> Paste-ready context for a fresh Claude Code session. Preferred language: **Bahasa Indonesia, casual.**

## Repo & Infra
- **Code (local):** `C:\Users\<you>\Documents\polymarket-bot` (run `setup.cmd` on a new machine to clone+install+build)
- **GitHub (public):** https://github.com/nicholassamuel-hash/hyperliquid-mm-bot
- **VPS:** Nevacloud Jakarta, `root@202.155.132.247` — SSH: `ssh -i $env:USERPROFILE\.ssh\neva-bot root@202.155.132.247` (repo on VPS at `~/bot`)
- **Stack:** TypeScript, Node 24 (built-in `node:sqlite`), `@nktkas/hyperliquid`, PM2. 119 vitest tests.
- ⚠️ VPS wall-clock runs **~+14h ahead** of real time (NTP drift) — harmless for paper, but **must fix before any live trading** (order-signing timestamps).

## Status (PAPER — no real money)
- PM2 process **`auction`** is LIVE on the VPS running **v5 "max-config"**. Old market-maker process `paper` = **stopped** (it was structurally negative-EV).
- Modal **$30 USDC** (not deposited). Goal = **experiment + learning** (OK to lose it). Jakarta latency ~250ms.
- **2026-06-10: instrumented** (logging-only, no logic change). Each closed round-trip now writes a `trades` row with entry-time context (regime, RVOL, trigger, gross-vs-fees). Read it with **`npm run analyze:auction`** — slices WR/gross by regime/exit/coin so the "no edge" question is answered by *where*, not one blind net. See [VERDICT.md](./VERDICT.md) for the decision rule (gate to a +gross regime, else pivot — don't blind-tune).

## What the bot is — AMT auction-reversion (latency-insensitive, directional)
Fades failed auctions back to value; holds positions minutes–hours (so 250ms latency is irrelevant). Full stack, all config-gated, all ON in v5:
1. **band-fade** — VWAP ±2σ bands = value area (VAL/VWAP/VAH)
2. **failed-auction filter** — RVOL low (no acceptance) ; skip if RVOL spikes (Law 3 trap)
3. **CVD/price divergence** confirm — price up + CVD down = short, mirror for long
4. **maker fills** — limit at band/target (1.5bp vs 4.5bp taker)
5. **regime filter** — VWAP slope: fade only in range / with the trend, skip counter-trend
6. **trapped-reclaim entry** — price broke band then reclaimed back inside = trapped traders covering
7. **order-book wall** confirm — `detectWalls` resting absorber
8. **trailing exit** — tag partial target → stop to breakeven → run to full VWAP
Config: `AUCTION_*` env vars (defaults in `src/config.ts`). Coins: BTC,ETH,SOL,HYPE. Size $5/trade.

## Key files
- `src/strategy/auctionSignals.ts` — VWAP/bands, RVOL, delta/CVD, `vwapSlopeBps`, `priceNBarsAgo`
- `src/strategy/auctionReversion.ts` — the per-coin FSM (entry/exit decision logic)
- `src/strategy/orderbook.ts` — `detectWalls`
- `src/sim/directionalBook.ts` — paper fill executor (maker/taker)
- `src/sim/runAuction.ts` — runner; also writes `data/state.json` every 5s (dashboard feed)
- `dashboard/server.mjs` + `dashboard/index.html` — local dashboard (SSH-reads state.json)

## The big finding (HONEST — important)
Across **every** version, gross PnL (before fees) is ≈ **FLAT** → the reversion edge is ≈ **zero** on liquid perps using public signals. Trajectory: MM −$58/18h (structural dead) → auction v1 −$0.93 → v3 −$0.13 (gross flat, loss = fees) → v4 maker (fees cut) → **v5 = best shot** (regime + trapped + trail). **If v5 is STILL gross-flat after a real sample → there is no edge here; pivot to funding-harvest / niche (small) coins / HLP vault — NOT more signal-tuning (that's the MM trap).**

## Operations
- **Deploy:** on VPS `cd ~/bot && git pull --ff-only && npm run build && pm2 restart auction --update-env`. (`.env` on VPS is gitignored; new config vars use defaults in `src/config.ts`. VPS `.env` currently sets `AUCTION_USE_DIVERGENCE=true` etc.)
- **Check:** `ssh ... "pm2 logs auction --nostream --lines 30"` → read `net` + `exits:{}` (in-memory, this run). Or **dashboard:** `npm run dashboard` → http://localhost:8787 (or `start-dashboard.cmd` / desktop shortcut).
- **Edge breakdown (the real read):** on the VPS `cd ~/bot && npm run analyze:auction` (optional `[hours]` arg) → per-regime / per-exit / per-coin WR + **gross (edge) vs net (after fees)**. Needs closed round-trips, so let it bake first.
- **Data:** `data/auction.db` (fills) + `data/state.json` (live snapshot) on VPS, both gitignored.
- **Dev:** `npm test` · `npm run build` · `npm run typecheck`.
- Restart resets the in-memory PnL counter + ~30min signal warm-up (data persists in db/logs).

## Where to pick up
v5 deployed 2026-06-09, warming then **baking**. **Let it run 24–48h, then read.** Three outcomes:
- `net` positive + target-hits up → **edge found**, scale (size/coins).
- `net` flat (enough trades) → **edge confirmed absent** → pivot (funding/niche/HLP).
- ~0 trades → **too selective** → loosen (regime/trapped/wall are OR-able, or `bandK=1`).

## User context
Indonesia; replies in casual Indonesian. Wants **honest** assessment, not hype. $30 paper, learning-first. Trades via **Auction Market Theory / orderflow** (value areas, VWAP bands, footprint/delta) — lead with AMT primitives, not RSI/MACD. Source PDFs at `C:\Users\<you>\Downloads\Trading.txt\`. Other projects: gold mean-reversion bot, TradingView toolkit.
