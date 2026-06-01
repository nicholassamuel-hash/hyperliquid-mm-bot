# Hyperliquid MM Bot

Market-making bot for Hyperliquid perp DEX. Built in TypeScript, designed for paper trading first then optional live deployment.

```
┌─────────────────────────────────────────────────────────────┐
│  Paper → Backtest → Live (DRY-RUN) → Live (small) → Scale   │
└─────────────────────────────────────────────────────────────┘
```

## Features

- ✅ **Paper trading** vs live Hyperliquid orderbook
- ✅ **Live trading** via @nktkas/hyperliquid SDK
- ✅ **Backtest engine** — record live, replay through strategy
- ✅ **CLI dashboard** — real-time stats from SQLite
- ✅ **6 strategy fixes** — join/improve quoting, vol-adaptive, queue model, OBI, inventory bias, outcome tracking
- ✅ **Safety guards** — dry-run mode, emergency cancel-all, error-rate kill switch
- ✅ **Production deploy** — Docker, PM2, systemd-friendly
- ✅ **45 unit tests** — math, inventory, vol, paperBook, adverseGuard

## Quick start (5 minutes, no real money)

```powershell
# Windows
cd C:\Users\palkon\Documents\polymarket-bot
npm install
copy .env.example .env
npm run paper
```

```bash
# Linux / Mac
cd polymarket-bot
npm install
cp .env.example .env
npm run paper
```

In another terminal: `npm run dashboard` for live stats.

## All commands

| Command | What it does |
|---|---|
| `npm run paper` | Run paper trader against LIVE orderbook (zero risk) |
| `npm run backtest -- <file.jsonl>` | Replay recorded orderbook through strategy |
| `npm run record -- BTC 3600` | Record live data to JSONL for backtesting |
| `npm run live` | LIVE trading. Reads `.env`. Set `DRY_RUN=true` first time. |
| `npm run dashboard` | Real-time terminal dashboard |
| `npm run gen-wallet` | Generate fresh EVM keypair (writes `.env.wallet`) |
| `npm test` | Run unit tests (45 tests) |
| `npm run typecheck` | TypeScript verification |
| `npm run build` | Compile to `dist/` |

## Configuration

All in `.env` (copy from `.env.example`). Key parameters:

| Param | What | Default |
|---|---|---|
| `COINS` | Comma-separated tickers (BTC, ETH, SOL, HYPE…) | `HYPE` |
| `QUOTE_MODE` | `join` (at touch) / `improve` (1 tick inside) / `outside` (legacy) | `join` |
| `HALF_SPREAD_BPS_MIN` | Half-spread floor in bps | `1.5` |
| `QUOTE_SIZE_USD` | Notional per quote side | `2` |
| `MAX_POSITION_USD` | Cap on net position notional | `20` |
| `MAX_MARGIN_USD` | Cap on margin used | `15` |
| `ADVERSE_THRESHOLD_BPS_MIN` | Cancel when opposite side drifts this close | `3` |
| `OBI_WEIGHT` | Order book imbalance influence (0-1) | `0.5` |
| `INV_FLAT_WEIGHT` | Inventory mean-reversion influence (0-1) | `0.6` |

See `.env.example` for full list.

## Architecture

```
WS (l2Book, trades)
        ↓
MarketMaker — join/improve quoting + vol adapt + OBI + inv-bias
        ↓
[QuoteCommand]
        ↓                              ↓
   placeQuote                    AdverseGuard
   (paper or live)                cancel on drift
        ↓
PaperBook (queue model)  |  LiveClient (real orders)
        ↓                              ↓
   Inventory + StateDB (fills, outcomes, daily PnL)
        ↓
   Dashboard (read-only TUI)
```

## Project layout

```
src/
├── client/        WS + REST + LiveClient (order signing)
├── strategy/      MM logic + adverse guard
├── state/         Inventory + SQLite
├── sim/           PaperBook, runPaper, runLive, recorder, runBacktest
├── util/          logger, math, vol tracker
├── cli/           dashboard
├── config.ts
├── types.ts
└── index.ts

scripts/
└── gen-wallet.ts  # safe wallet generator

tests/             # 45 unit tests
docs/              # MORNING_BRIEFING_v2, SETUP, ARCHITECTURE, DEPLOYMENT
```

## Going live — short version

1. Paper trade for ≥ 24h
2. `npm run gen-wallet` — save the address output
3. Fund the address with USDC on Arbitrum, bridge to Hyperliquid via web UI
4. Merge `.env.wallet` contents into `.env`
5. `DRY_RUN=true npm run live` — verify quotes appear correctly
6. `npm run live` — real trading. Watch closely.
7. Emergency stop: `Ctrl+C` (graceful, cancels all)

Full guide: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Honest expectations

For retail tier ($1-100 modal), **expect break-even at best**. Hyperliquid maker fee is 0.015% (1.5 bps) — natural BTC/SOL spread is often *tighter than the fee*. The strategy works structurally but the edge is razor-thin at retail volume.

**Reasonable use cases:**
- Learn perp microstructure with real (paper) data
- Have working portfolio piece for trading systems development
- Run experiments on tuning, vol adapt, OBI, etc.
- Bootstrap to higher modal that hits volume rebate tiers

**Bad use cases:**
- "Get rich quick" — not happening
- Replace job — not happening
- Outperform HFT shops — not happening from retail VPS

## Disclaimer

Personal use, provided as-is. Trading involves substantial risk of loss.
Author is not licensed; nothing here is financial advice.

## License

MIT — see [LICENSE](./LICENSE).
