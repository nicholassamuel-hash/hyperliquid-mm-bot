/**
 * Rolling volatility tracker over the last N mid prices.
 *
 * Tracks:
 *   - return-based stddev (logreturn of consecutive mids)
 *   - simple stddev of mid changes (in bps of mean)
 *
 * Used by strategy to scale half-spread and adverse threshold adaptively.
 */
export class VolTracker {
  private mids: number[] = [];
  private timestamps: number[] = [];

  constructor(private readonly windowSize = 60) {}

  push(mid: number, ts: number) {
    if (!Number.isFinite(mid) || mid <= 0) return;
    this.mids.push(mid);
    this.timestamps.push(ts);
    if (this.mids.length > this.windowSize) {
      this.mids.shift();
      this.timestamps.shift();
    }
  }

  /** Number of samples in window. */
  count(): number {
    return this.mids.length;
  }

  /** Mean of mids in window. */
  mean(): number {
    if (this.mids.length === 0) return 0;
    let sum = 0;
    for (const m of this.mids) sum += m;
    return sum / this.mids.length;
  }

  /**
   * Standard deviation of mid changes, expressed as basis points of mean.
   * Returns 0 if window not warm yet.
   *
   * @param window Optional. Use only last N mids (for short-window vol).
   *               Defaults to all buffered mids (long-window).
   */
  stddevBps(window?: number): number {
    const sample =
      window !== undefined && window > 0 && window < this.mids.length
        ? this.mids.slice(-window)
        : this.mids;
    if (sample.length < 2) return 0;
    let sum = 0;
    for (const m of sample) sum += m;
    const mean = sum / sample.length;
    if (mean === 0) return 0;
    let sumSq = 0;
    for (let i = 1; i < sample.length; i++) {
      const delta = sample[i]! - sample[i - 1]!;
      sumSq += delta * delta;
    }
    const variance = sumSq / (sample.length - 1);
    const std = Math.sqrt(variance);
    return (std / mean) * 10_000; // bps
  }

  /**
   * Detect vol spike: ratio of recent short-window vol to PRE-SPIKE baseline.
   *
   * Important: baseline window uses bars BEFORE the short window so the
   * baseline is not contaminated by the spike itself. This gives clean ratio
   * detection: short=last 5 bars, baseline=30 bars preceding those 5.
   *
   * Requires buffer of at least (shortWindow + baselineWindow) bars.
   * Returns 0 if not enough history or baseline vol is 0.
   */
  spikeRatio(shortWindow = 5, baselineWindow = 30): number {
    const needed = shortWindow + baselineWindow;
    if (this.mids.length < needed) return 0;
    const shortSample = this.mids.slice(-shortWindow);
    const baselineSample = this.mids.slice(-needed, -shortWindow);
    const shortStd = this._stdBpsOf(shortSample);
    const baselineStd = this._stdBpsOf(baselineSample);
    if (baselineStd === 0) return 0;
    return shortStd / baselineStd;
  }

  private _stdBpsOf(sample: number[]): number {
    if (sample.length < 2) return 0;
    let sum = 0;
    for (const m of sample) sum += m;
    const mean = sum / sample.length;
    if (mean === 0) return 0;
    let sumSq = 0;
    for (let i = 1; i < sample.length; i++) {
      const delta = sample[i]! - sample[i - 1]!;
      sumSq += delta * delta;
    }
    const variance = sumSq / (sample.length - 1);
    return (Math.sqrt(variance) / mean) * 10_000;
  }

  /** Log-return based stddev in bps, annualized would need more context. */
  logReturnStdBps(): number {
    if (this.mids.length < 2) return 0;
    const rets: number[] = [];
    for (let i = 1; i < this.mids.length; i++) {
      if (this.mids[i - 1]! <= 0) continue;
      rets.push(Math.log(this.mids[i]! / this.mids[i - 1]!));
    }
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance =
      rets.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (rets.length - 1);
    return Math.sqrt(variance) * 10_000;
  }
}
