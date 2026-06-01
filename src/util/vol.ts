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
   */
  stddevBps(): number {
    if (this.mids.length < 2) return 0;
    const mean = this.mean();
    if (mean === 0) return 0;
    let sumSq = 0;
    for (let i = 1; i < this.mids.length; i++) {
      const delta = this.mids[i]! - this.mids[i - 1]!;
      sumSq += delta * delta;
    }
    const variance = sumSq / (this.mids.length - 1);
    const std = Math.sqrt(variance);
    return (std / mean) * 10_000; // bps
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
