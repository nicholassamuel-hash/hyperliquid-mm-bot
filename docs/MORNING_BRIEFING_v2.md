# Briefing v2 — Hyperliquid MM Setelah 6 Fix Major

*Update: 1 Juni 2026*

## Tujuan briefing ini

Briefing v1 mendokumentasikan setup awal. v2 ini mendokumentasikan:
1. **Bug fix** ditemukan & dibetulkan dari live testing
2. **6 fix arsitektur** untuk problem fundamental
3. **Live observation** dari market real
4. **Reality check** apa yang sebenarnya feasible dengan modal $30

---

## Yang berubah dari v1

### 🐛 Bug fix: inventory partial-close
- **Discovery**: live testing menunjukkan PnL $1.47 dari spread $0.022 — impossible
- **Root cause**: weight-averaging entry price diterapkan saat partial close, padahal entry remainder seharusnya unchanged
- **Fix**: tambah case explicit untuk partial close, entry unchanged
- **Regression tests**: 2 test baru di `tests/inventory.test.ts`

### ✨ 6 architectural improvements

| # | Fix | File | Impact |
|---|---|---|---|
| 1 | Join/improve touch quoting (bukan outside) | `strategy/marketMaker.ts` | Quote sekarang feasible — sebelumnya bot refuse karena halfSpread > natural spread |
| 2 | Tick size & min size dari meta | `client/hyperliquid.ts` (+ `inferPricePrecision`) | Quote price/size always valid untuk live submission |
| 3 | Outcome tracking di SQLite | `state/db.ts` + `runPaper.ts` | Bisa hitung `fillRatePct`, `cancelled_adverse`, dsb |
| 4 | Queue position model di paperBook | `sim/paperBook.ts` | Fill simulation realistic — discount by depth ahead di level |
| 5 | Volatility-adaptive params | `util/vol.ts` (baru) | Spread scaling dengan realized vol rolling window |
| 6 | OBI signal + inventory flat-bias | `strategy/marketMaker.ts` | Quote skewing berdasarkan depth imbalance + posisi |

---

## Real test results

### Run 1 — `improve` mode, edge gate aktif
```
30s: 51 quote attempts, 0 placed, 0 fills
cancelled_skip=51 → edge gate menolak karena fee 3 bps > natural spread HYPE
```
**Lesson**: Hyperliquid mainstream perp spread terlalu tight untuk fee-aware retail MM.

### Run 2 — `improve` mode, edge gate off
```
30s: placed=51, cancelled_adverse=47, fills=1, fillRatePct=1.96%
Position: short 0.03 HYPE @ 72.89, realized -$0.000328, unrealized +$0.00168
```
**Lesson**:
- Bot WORKS — fills real, queue model active
- **92% adverse rate** = informed flow consistently beats us
- 1 fill / 51 placements = real-world fill rate retail tier

### Run 3 — Tuned: `join` mode, threshold 3 bps, cooldown 400ms
```
60s: placed=107, cancelled_adverse=104, fills=2, fillRatePct=1.87%
Position: short 0.06 HYPE @ 72.24
Realized PnL: -$0.000650 (cumulative maker fees)
Unrealized: +$0.00120 (market drifted favorably)
Net hypothetical: +$0.00055
```

**Lessons dari Run 3:**
- `join` mode: fill rate puncak 3.92% di first 30s (vs 1.96% improve mode di Run 2) → ✅ confirmed less competitive = more fills
- Adverse rate naik dari 92% → 97% → bot tetap kena informed flow di setiap quote, latency Indonesia bottleneck
- **Activity 2x dari Run 2** (107 vs 51 placed) — cooldown 400ms tidak terlalu restrictive
- Position drift to short — funding rate kemungkinan negatif HYPE (shorts pay), tapi unrealized PnL positif → market mean-reverted favorably
- Cumulative fee $0.00065 over 2 fills = $0.000325 per fill — sesuai 0.015% × $2 notional

---

## Insight kunci untuk strategi

### Mengapa `improve` mode lebih buruk dari `join`
- Improve berarti **kita yang offer harga terbaik** → magnet untuk informed flow
- Join berarti **kita join existing queue** → less likely to be "picked off"
- Pada HYPE volatile, market move 1-2 bps per detik → improve quote di-cancel sebelum filled

### Mengapa adverse rate tinggi
- Latency Indonesia → AWS US East ~200-350ms
- Market microstructure update <10ms
- Tiap saat kita "lihat" book, sudah outdated 200ms+
- Quote yang kita place sudah stale di moment placement

### Mengapa MM retail tier ekonominya marginal
```
Fee maker = 1.5 bps × 2 sides = 3 bps round-trip
HYPE natural spread (sample): 0.3 - 3 bps
Expected captured (improve mode): natural_spread - 2 ticks ≈ 0.5 bps
Net per round-trip: 0.5 - 3 = -2.5 bps (NEGATIVE)
```
Untuk profitable, butuh minimum salah satu:
- Modal $1K+ untuk hit volume tier rebate (maker fee turun ke 0% atau negative)
- Latency <50ms (colo VPS di lokasi exchange)
- Niche coin dengan spread > 5 bps konsisten

---

## Current state codebase

```
src/
├── config.ts                  # 14 params, all validated
├── types.ts                   # Perp position, market context with tickSize/minSz
├── client/
│   ├── websocket.ts           # Hyperliquid WSS, auto-reconnect, ping/pong
│   └── hyperliquid.ts         # REST + inferPricePrecision
├── strategy/
│   ├── marketMaker.ts         # join/improve/outside modes + vol + OBI + inv-bias
│   └── adverseGuard.ts        # 4 sinyal adverse, bps-based
├── state/
│   ├── db.ts                  # fills, quotes, outcomes, daily_pnl tables
│   └── inventory.ts           # perp tracker, FIXED partial-close bug
├── sim/
│   ├── paperBook.ts           # queue model — discount fill by depth ahead
│   └── runPaper.ts            # composition, periodic outcome stats
├── util/
│   ├── logger.ts
│   ├── math.ts                # Hyperliquid fee model, liq, funding
│   └── vol.ts                 # rolling volatility tracker
└── index.ts

tests/                         # 45 tests (vol, math, inventory, paperBook, adverseGuard)
```

## Test suite

`npm test` → **45/45 passing**
- vol.test.ts (10 tests) — rolling std + inferPricePrecision
- inventory.test.ts (10 tests) — including 2 regression tests untuk partial-close bug
- math.test.ts (12 tests) — Hyperliquid fee model, liq price, funding cost
- paperBook.test.ts (8 tests) — queue model dengan depth-ahead
- adverseGuard.test.ts (5 tests) — 4 sinyal detection

---

## Honest recommendation per modal

| Modal | Strategi rekomendasi | Expected outcome |
|---|---|---|
| **$30 (sekarang)** | Tetap paper trading dengan bot ini, atau pivot ke HLP vault passive | Live deploy: -100% kemungkinan dalam 1-2 hari |
| $100-500 | Same paper trading + observe live tanpa deposit | Learning-only |
| $1K | Deposit + try smallest-size live MM di niche coin | Break-even ± 10% monthly |
| $5K+ | Multi-coin MM, hit Tier 1 rebate possibly | 0-3% monthly |
| $20K+ | Eligibly start chasing volume tier rebates | 2-8% monthly |

---

## Phase 2 activation (kalau lanjut live)

Sama dengan v1 [SETUP.md](./SETUP.md), tapi tambah:
- Set `QUOTE_MODE=join` (not improve)
- Implement `createLiveClient` di `hyperliquid.ts` pakai `ExchangeClient` dari `@nktkas/hyperliquid`
- Add `runLive.ts` yang call real `client.order(...)` dan `client.cancel(...)`
- Verify deposit USDC via Arbitrum bridge ke Hyperliquid UI manual dulu
- VPS Singapore (Vultr ~$5/bln) — latency Indonesia → SG ~30ms vs US East ~200ms

## Kalau hasil paper trading tidak menjanjikan

Codebase masih berharga karena:
1. **Skill development real** (perp MM mechanics, vol-adaptive, queue modeling, adverse selection)
2. **Reusable untuk market lain**: Hyperliquid HIP-4 prediction markets (orderbook structure mirip), Aevo, Drift, Vertex (Solana perp DEX) — semua butuh swap client layer saja
3. **Portfolio piece** untuk demonstrate trading systems development

## Yang TIDAK saya implement (out of scope)

- ❌ Backtest engine — butuh historical L2 data
- ❌ Live order signing — Phase 2, wallet handling
- ❌ Funding rate arbitrage strategy (delta-neutral via spot)
- ❌ Multi-coin correlation MM
- ❌ Prometheus metrics + Grafana

---

## Decision log

| Tanggal | Decision | Rationale |
|---|---|---|
| 31 Mei | Pivot dari Polymarket ke Hyperliquid | Polymarket diblock Indonesia 22 Mei 2026 |
| 31 Mei | Pakai Node.js + TypeScript bukan Python | Already familiar, mature SDK community-maintained |
| 31 Mei | `@nktkas/hyperliquid` SDK | Best-documented community TS SDK |
| 1 Juni | Pivot ke `node:sqlite` dari `better-sqlite3` | Avoid Windows VS C++ build dependency |
| 1 Juni | Detected & fixed inventory partial-close bug | Real testing > pure unit tests |
| 1 Juni | 6 architectural fixes (join mode, queue model, vol adapt, OBI, outcome track, meta) | First real test exposed `spread too tight` blocker dan fee economics |
