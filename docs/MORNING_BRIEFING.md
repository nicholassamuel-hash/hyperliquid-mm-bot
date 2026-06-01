# Briefing — Hyperliquid MM Pivot

## ✅ Status

| Step | Hasil |
|---|---|
| Pivot codebase ke Hyperliquid | ✅ Complete |
| `npm install` (deps Hyperliquid SDK) | ✅ exit 0, 0 errors |
| `npm run typecheck` | ✅ Zero error |
| `npm test` (vitest) | ✅ **31/31 passing** |
| `npm run paper` end-to-end | ⏸️ Belum di-test live — butuh internet ke `api.hyperliquid.xyz` |

## 🔄 Apa yang berubah dari versi Polymarket

| Komponen | Polymarket | Hyperliquid |
|---|---|---|
| Asset identifier | Token ID (numeric string) | Coin name (BTC, ETH, dll) |
| Sizing unit | Shares ($0.01-$0.99 per share) | Coin units (0.0001 BTC, dll) |
| Quote size config | Shares count | **USD notional** (dipakai untuk derive coin size) |
| Half-spread config | Cents | **Basis points** of mid |
| Adverse threshold | Cents | **Basis points** of mid |
| Fee model | Maker rebate 20-25% taker fee | Maker pays 0.015%, taker 0.045% — no retail rebate |
| Position concept | Long shares (binary 0-1) | Long/short coin (with leverage, funding, liq risk) |
| Funding rate | N/A | **Tracked & skews quotes** if abs(funding) > threshold |
| Liquidation | N/A | Modeled in math utils |

## 🔧 Apa yang harus Anda lakukan untuk run paper

```powershell
cd C:\Users\palkon\Documents\polymarket-bot
copy .env.example .env
notepad .env
# Default sudah set COINS=BTC. Ubah ke ETH/SOL kalau mau lain.
npm run paper
```

Tunggu 1-2 menit. Anda akan lihat log:
- `WS connected, subscribing`
- `Market context refreshed` (mark price, funding rate)
- `Quote placed (paper)` — bot mau place quote di harga X
- `Adverse cancel` — bot cancel karena ada drift
- `PAPER FILL` — simulasi fill
- `Periodic stats` tiap 30 detik
- `Funding tick applied` tiap jam

Biarkan jalan beberapa jam, cek `data/bot.db` untuk hipotetik P&L.

## 🎯 Setting yang sudah saya tune untuk $30 modal

```
COINS=BTC
HALF_SPREAD_BPS=5         # 5 bps = 0.05% — agak konservatif untuk BTC liquid
QUOTE_SIZE_USD=2          # $2 per quote side — micro size
MAX_POSITION_USD=20       # cap inventory exposure
MAX_MARGIN_USD=15         # cap margin (sekitar 50% modal Anda)
REPLACE_COOLDOWN_MS=200   # min 200ms antar re-quote
ADVERSE_THRESHOLD_BPS=3   # cancel kalau drift dalam 3 bps
FUNDING_SKEW_THRESHOLD=0.0001  # mulai skew di funding 1 bp/hr (~8.76% annualized)
```

**Honest expectation**: paper run di BTC akan show fills jarang tapi konsisten kecil. Pasar BTC sangat ramai dengan MM bots — Anda akan jadi salah satu dari banyak. Untuk dapat fill, half-spread perlu agak sempit (5 bps udah agak ketat).

## 🚨 Gotchas yang sudah saya antisipasi

1. **`@nktkas/hyperliquid` v0.32.2 installed** — community SDK terbaik. Untuk Phase 2 live, butuh `ExchangeClient` dengan viem signer.

2. **Hyperliquid universe & szDecimals** — tiap coin punya size precision beda. BTC szDecimals biasanya 5, ETH 4, SOL 2. Saya fetch via `/info` REST tiap 60s dan cache.

3. **Funding tick** — applied per jam di runPaper. Realisitik di live, funding di-charge di mark-to-market basis, bukan discrete tick — tapi cukup untuk PnL accounting.

4. **Spread BTC sangat tight** (sering 1-2 USD = ~3 bps) — bot mungkin sering cancel quote karena "spread too tight". Coba `ETH` atau `SOL` kalau mau lebih banyak action.

5. **No native compilation needed** — pakai `node:sqlite` built-in dan `ws` (pure JS).

6. **ToS Hyperliquid larang VPN** — Indonesia tidak di restricted list, akses langsung dari ISP Anda **clean**. Jangan pakai VPN.

## Phase 2 activation (live trading)

Lihat [`SETUP.md`](./SETUP.md) untuk checklist lengkap. TL;DR:

1. Generate wallet baru (EVM-compatible, Phantom/MetaMask)
2. Beli USDC, bridge ke Arbitrum, deposit ke Hyperliquid via UI
3. Set `WALLET_PRIVATE_KEY` di `.env`
4. Implement `createLiveClient()` di `src/client/hyperliquid.ts` (reference comment sudah ada)
5. Create `src/sim/runLive.ts` mirror dari `runPaper.ts`
6. Deploy di VPS Singapore (Vultr/Hetzner $5/bln, latency Indonesia → Tokyo ~80ms)

## Decision tree setelah Anda evaluate paper

| Metrik 24-48 jam paper | Aksi |
|---|---|
| Fills > 50, hipotetik PnL ≥ 0 | OK, lanjut ke Phase 2 dengan modal kecil |
| Fills > 50, PnL negatif konsisten | Tune `HALF_SPREAD_BPS` lebih lebar, pindah coin |
| Fills < 5 dalam 24 jam | `HALF_SPREAD_BPS` terlalu lebar atau coin terlalu sepi |
| Adverse cancel >70% dari quote yang ke-place | `ADVERSE_THRESHOLD_BPS` terlalu sensitif — naikkan |

## 🛡️ Yang TIDAK ada (by design, Phase 2 work)

- ❌ Order signing & submission live
- ❌ Wallet private key handling
- ❌ Funding rate management strategy (cuma tracked, belum dijadiin trade signal mandiri)
- ❌ Multi-coin portfolio optimization
- ❌ Liquidation alert/auto-deleverage
- ❌ Cross-margin tracking (kalau pakai cross mode)
