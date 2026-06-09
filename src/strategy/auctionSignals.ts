/**
 * Auction signal layer for the AMT reversion strategy (strategy "B+D").
 *
 * Consumes the raw Hyperliquid trade stream and derives the value-area +
 * orderflow primitives the strategy needs — all from data we already
 * subscribe to (`trades`), no extra feeds:
 *
 *   - Rolling volume-weighted VWAP + std-dev bands → value-area proxy.
 *     (Per the user's VWAP material: "vwap bands act as a value area",
 *      VWAP = POC, ±kσ = VAH/VAL.)
 *   - RVOL (relative volume) → acceptance vs failed-auction velocity tell.
 *     (ORDERFLOW.pdf: "RVOL gives us a footprint chart without looking at one";
 *      volume picking up = acceptance, no pickup = failed auction → fade.)
 *   - Delta (aggressor buy − sell) + CVD → orderflow direction / absorption.
 *
 * Trades are binned into fixed time bars to bound memory and match the
 * candle-based "velocity/acceptance" reasoning in the AMT material.
 */
import type { Side } from "../types.js";

interface Bar {
  /** Bar index = floor(ts / barMs). */
  idx: number;
  /** Σ size (volume). */
  vol: number;
  /** Σ price·size. */
  pv: number;
  /** Σ price²·size. */
  ppv: number;
  /** Aggressor delta: Σ(buy size) − Σ(sell size). */
  delta: number;
}

export interface VwapBands {
  vwap: number;
  sd: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
}

export class AuctionSignals {
  private bars: Bar[] = [];
  private current: Bar | null = null;
  private cvdTotal = 0;
  private vwapHist: number[] = []; // window VWAP at each bar close (for slope/regime)

  /**
   * @param barMs    Bar interval in ms (default 60s).
   * @param maxBars  Rolling window length in bars (default 240 = 4h @ 1m).
   * @param warmBars Minimum completed bars before signals are trusted.
   */
  constructor(
    private readonly barMs = 60_000,
    private readonly maxBars = 240,
    private readonly warmBars = 30,
  ) {}

  /** Ingest one aggressor trade. */
  pushTrade(price: number, size: number, side: Side, ts: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(size) || size <= 0) return;
    const idx = Math.floor(ts / this.barMs);
    if (!this.current || idx > this.current.idx) {
      if (this.current) this.finalize(this.current);
      this.current = { idx, vol: 0, pv: 0, ppv: 0, delta: 0 };
    }
    // Trades with idx <= current (out-of-order/same bar) fold into the current bar.
    const c = this.current;
    c.vol += size;
    c.pv += price * size;
    c.ppv += price * price * size;
    c.delta += side === "BUY" ? size : -size;
  }

  private finalize(bar: Bar): void {
    this.cvdTotal += bar.delta;
    this.bars.push(bar);
    if (this.bars.length > this.maxBars) this.bars.shift();
    // Record the window VWAP over completed bars (for regime/slope).
    let v = 0;
    let pv = 0;
    for (const b of this.bars) {
      v += b.vol;
      pv += b.pv;
    }
    this.vwapHist.push(v > 0 ? pv / v : 0);
    if (this.vwapHist.length > this.maxBars) this.vwapHist.shift();
  }

  /** Completed-bar count (current forming bar excluded). */
  barCount(): number {
    return this.bars.length;
  }

  /** True once enough completed bars exist for the window stats to be trusted. */
  warm(): boolean {
    return this.bars.length >= this.warmBars;
  }

  /** Σ over completed bars + the current forming bar (latest fair value). */
  private sums(): { vol: number; pv: number; ppv: number } {
    let vol = 0;
    let pv = 0;
    let ppv = 0;
    for (const b of this.bars) {
      vol += b.vol;
      pv += b.pv;
      ppv += b.ppv;
    }
    if (this.current) {
      vol += this.current.vol;
      pv += this.current.pv;
      ppv += this.current.ppv;
    }
    return { vol, pv, ppv };
  }

  /** Rolling volume-weighted average price over the window. 0 if no volume. */
  vwap(): number {
    const { vol, pv } = this.sums();
    return vol > 0 ? pv / vol : 0;
  }

  /** Volume-weighted standard deviation of price over the window. */
  sd(): number {
    const { vol, pv, ppv } = this.sums();
    if (vol <= 0) return 0;
    const mean = pv / vol;
    const variance = ppv / vol - mean * mean;
    return variance > 0 ? Math.sqrt(variance) : 0;
  }

  /** VWAP ± 1σ / ± 2σ bands (value-area proxy: VWAP≈POC, ±σ≈VAL/VAH). */
  bands(): VwapBands {
    const vwap = this.vwap();
    const sd = this.sd();
    return {
      vwap,
      sd,
      upper1: vwap + sd,
      lower1: vwap - sd,
      upper2: vwap + 2 * sd,
      lower2: vwap - 2 * sd,
    };
  }

  /**
   * Relative volume of the most recent COMPLETED bar vs the average of the
   * prior completed bars. >1 = above-average velocity (acceptance), <1 = quiet
   * (failed auction). Uses the last completed bar (stable, not the partial one).
   */
  rvol(): number {
    if (this.bars.length < 2) return 0;
    const last = this.bars[this.bars.length - 1]!;
    let sum = 0;
    for (let i = 0; i < this.bars.length - 1; i++) sum += this.bars[i]!.vol;
    const avg = sum / (this.bars.length - 1);
    return avg > 0 ? last.vol / avg : 0;
  }

  /**
   * Aggressor delta summed over the last `n` completed bars plus the current
   * forming bar. Positive = net aggressive buying, negative = net selling.
   */
  recentDelta(n = 3): number {
    let d = this.current ? this.current.delta : 0;
    const start = Math.max(0, this.bars.length - n);
    for (let i = start; i < this.bars.length; i++) d += this.bars[i]!.delta;
    return d;
  }

  /** Running cumulative volume delta over completed bars. */
  cvd(): number {
    return this.cvdTotal;
  }

  /**
   * Volume-weighted representative price of the completed bar `n` bars back
   * (n=1 → last completed bar). 0 if not enough history. Used for the
   * price-vs-CVD divergence check.
   */
  priceNBarsAgo(n: number): number {
    const idx = this.bars.length - n;
    if (idx < 0 || idx >= this.bars.length) return 0;
    const b = this.bars[idx]!;
    return b.vol > 0 ? b.pv / b.vol : 0;
  }

  /**
   * Slope of the rolling VWAP over the last `n` bars, in bps.
   * >0 = up-trend (VWAP rising), <0 = down-trend, ~0 = balance/range.
   * Used by the regime filter to fade only in range / with the trend.
   */
  vwapSlopeBps(n: number): number {
    if (this.vwapHist.length < n + 1) return 0;
    const now = this.vwapHist[this.vwapHist.length - 1]!;
    const ago = this.vwapHist[this.vwapHist.length - 1 - n]!;
    if (ago <= 0) return 0;
    return ((now - ago) / ago) * 10_000;
  }
}
