# Architecture

## Data flow (paper mode)

```
                     Polymarket WSS (wss://ws-subscriptions-clob.polymarket.com/ws/market)
                                       │
                                       ▼
                              src/client/websocket.ts
                               (reconnect + parse)
                                       │
                  ┌────────────────────┼────────────────────┐
                  │                    │                    │
                  ▼                    ▼                    ▼
              "book" event      "price_change" event   "trade" event
                  │                    │                    │
                  ▼                    ▼                    ▼
         strategy.onBook()    strategy.onPriceChange()  paperBook.matchTrade()
                  │                    │                    │
        QuoteCommand(place)    QuoteCommand(cancel)        Fill?
                  │                    │                    │
                  ▼                    ▼                    ▼
           db.recordQuote()      mm.cancel()         inventory.apply()
                                                    db.recordFill()
                                                    log.info("PAPER FILL")
```

## Module responsibilities

### `client/websocket.ts`
- Single source of WSS events
- Reconnect with exponential backoff (1s → 32s cap)
- Normalizes raw Polymarket events to typed domain events
- Pong on server ping
- Stateless re: business logic

### `client/clob.ts`
- REST wrapper for orderbook snapshot, markets list (paper mode)
- `createLiveClient()` is a stub — throws until Phase 2

### `strategy/marketMaker.ts`
- Pure decision function: `onBook(snapshot, position) → QuoteCommand`
- Tracks current quote per token (in-memory)
- Inventory skew: kill the side that would breach `MAX_POSITION` or `MAX_INVENTORY_USD`
- Cooldown: don't churn quotes faster than `REPLACE_COOLDOWN_MS`

### `strategy/adverseGuard.ts`
- Standalone signal detector
- Checks 4 patterns: ask moved up, bid moved down, drift-against, large taker
- Stateless — takes quote + event, returns signal or null

### `state/inventory.ts`
- In-memory position tracker
- Realizes PnL on closing trades (avg-cost, not FIFO)
- Mark-to-market for unrealized

### `state/db.ts`
- SQLite (better-sqlite3) for durable storage
- Tables: `fills`, `quotes`, `daily_pnl`
- WAL journal mode for concurrent reads while bot writes

### `sim/paperBook.ts`
- Fill simulator
- Assumes 100% queue priority (overestimates fills by 2-3x vs live)
- Models fees as negative (rebate) for maker fills

### `sim/runPaper.ts`
- Composition root for paper trading
- Wires WS → strategy → simulator → state
- 30s periodic stats printer
- Graceful shutdown on SIGINT/SIGTERM

## Why these choices

| Decision | Reason |
|---|---|
| TypeScript + Node | Polymarket SDK is TS; ecosystem mature |
| ES modules | Modern, future-proof; matches SDK |
| SQLite | Embedded, zero config, fine for single-bot writes |
| pino logger | Fast, structured JSON, has pretty mode for dev |
| Zod for config | Catches typos in .env at startup, not runtime |
| In-memory inventory | Simple; daily snapshot to DB if you want crash recovery later |
| Avg-cost PnL | Most LP/MM strategies use avg-cost; FIFO if regulatory needs |
| Read-only Phase 1 | Decouples "learn the platform" from "risk real money" |

## What's missing on purpose (Phase 2 work)

- Order signing (EIP-712, CLOB V2)
- USDC/pUSD balance tracking on-chain
- Builder code attribution (Polymarket V2 feature for rebate sharing)
- Multi-market portfolio management
- Backtest engine over historical snapshots
- Prometheus metrics + Grafana dashboard
- Discord/Telegram alerts
