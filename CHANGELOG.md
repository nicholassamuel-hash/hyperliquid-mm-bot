# Changelog

## [0.2.0] — 2026-06-01

### Added
- **Phase 2 live trading** (`src/sim/runLive.ts` + `LiveClient` in `src/client/hyperliquid.ts`)
  - Real order submission via @nktkas/hyperliquid `ExchangeClient`
  - Dry-run mode via `DRY_RUN=true` env
  - Emergency `cancelAll()` on SIGINT/SIGTERM
  - Error-rate kill switch (5 errors / 60s → halt)
- **Backtest engine** (`src/sim/recorder.ts`, `src/sim/runBacktest.ts`)
- **CLI dashboard** (`src/cli/dashboard.ts`) — terminal TUI reading from SQLite
- **Wallet generator** (`scripts/gen-wallet.ts`) — creates fresh EVM keypair, writes `.env.wallet`
- **Production deployment** — `Dockerfile`, `docker-compose.yml`, `ecosystem.config.cjs`, `docs/DEPLOYMENT.md`
- 6 architectural strategy improvements:
  - **Fix 1**: `join`/`improve` quote modes (no more `spread too tight` lockout)
  - **Fix 2**: Tick size + min size from Hyperliquid meta (`inferPricePrecision`)
  - **Fix 3**: Outcome tracking — `placed`, `cancelled_adverse`, `cancelled_skip` counters
  - **Fix 4**: Queue position model in PaperBook (depth-ahead discount)
  - **Fix 5**: Volatility-adaptive params (`util/vol.ts`)
  - **Fix 6**: Order book imbalance signal + inventory flat-bias

### Fixed
- **Critical**: inventory partial-close bug — entry price was wrongly weight-averaged during partial close, inflating PnL. Now: entry of remaining position unchanged.
- 2 regression tests added in `tests/inventory.test.ts`

### Changed
- Pivot from Polymarket to Hyperliquid (Polymarket geo-blocked Indonesia 2026-05-22)
- Pivot from `better-sqlite3` (needs VS C++) to `node:sqlite` (built-in)
- Half-spread now in **bps** (was cents)
- Adverse threshold now in **bps**
- Default `QUOTE_MODE=join` (was implicitly `outside`)

### Project structure
- 12 source modules in `src/`
- 5 test files, 45 tests passing
- 4 docs (README, MORNING_BRIEFING_v2, DEPLOYMENT, ARCHITECTURE)

## [0.1.0] — 2026-05-31

### Added
- Initial Polymarket CLOB V2 paper trading bot
- WS subscriber, REST client, MM strategy, paper fill sim
- SQLite persistence, inventory tracker
- 31 unit tests
