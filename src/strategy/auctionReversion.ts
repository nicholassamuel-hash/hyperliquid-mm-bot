/**
 * Auction Market Theory reversion strategy ("B+D", fade mode).
 *
 * Edge (latency-insensitive, retail-viable — unlike market making):
 *   Fade FAILED AUCTIONS back to value, confirmed by orderflow.
 *
 * Maps to the user's AMT laws:
 *   - Price stretches outside the value area (VWAP ± kσ band).
 *   - If it's a FAILED auction (RVOL did NOT pick up → no initiative) AND
 *     orderflow shows the opposite side stepping in (delta flips / OBI leans),
 *     fade it back toward value (VWAP = POC). [AMT Law 1 & 4]
 *   - If instead RVOL SPIKES with delta in the breakout direction, that's
 *     ACCEPTANCE → do NOT fade (this is the trap that bled the MM bot). [Law 3]
 *
 * Exits: revert-to-value (price reaches current VWAP) = take profit;
 *        fixed stop beyond the band; acceptance-against = cut; time stop.
 *
 * Pure decision object — holds its own per-coin FSM and emits intents. The
 * runner executes fills and reports them back via onFill().
 */
import type { AuctionSignals } from "./auctionSignals.js";
import type { Walls } from "./orderbook.js";
import type { Side } from "../types.js";

export type AuctionAction = "enter_long" | "enter_short" | "exit" | "hold";

export interface AuctionIntent {
  action: AuctionAction;
  reason: string;
  /** Side of the position being opened/closed (for the executor). */
  side?: Side;
  /** Limit price for a maker fill (band edge for entry, target for exit). */
  limitPrice?: number;
  /** True if this fill should be modelled as a maker (resting limit) fill. */
  maker?: boolean;
}

export interface AuctionConfig {
  /** Which σ band marks the value-area edge to fade (1 or 2). */
  bandK: 1 | 2;
  /** RVOL above this = acceptance/initiative → do NOT fade. */
  rvolAcceptMax: number;
  /** Min |recentDelta| in the reversal direction to confirm (0 = sign only). */
  deltaConfirm: number;
  /** Min |OBI| in the reversal direction as an alternative confirmation. */
  obiConfirm: number;
  /** Stop placed this many σ beyond the entry price. */
  stopSigma: number;
  /** Time stop (ms) — exit if a position is held longer than this. */
  maxHoldMs: number;
  /** Cooldown (ms) after an exit before re-entering the same coin. */
  cooldownMs: number;
  /** If in-position and RVOL spikes >= this AGAINST us → acceptance, cut. */
  rvolFailExit: number;
  /** Grace period (ms) after entry before the acceptance-against cut may fire. */
  exitGraceMs: number;
  /** Take-profit fraction of the reversion toward VWAP (1 = full VWAP). */
  targetReversion: number;
  /** Require CVD/price divergence as the entry confirmation (stricter). */
  useDivergence: boolean;
  /** Lookback bars for the divergence check. */
  divergenceBars: number;
  /** Use maker (limit) fills for entries + target exits (cheaper fees). */
  useMaker: boolean;
  /** Regime filter: skip fades that fight the VWAP trend (fade range / with trend). */
  useRegime: boolean;
  /** Lookback bars for the VWAP-slope regime check. */
  regimeBars: number;
  /** |VWAP slope| (bps over regimeBars) above this = trending → gate that side's fades. */
  trendSlopeBps: number;
  /** Trapped mode: enter on RECLAIM back inside the band (failed breakout). */
  useTrapped: boolean;
  /** Lookback bars for the reclaim check. */
  reclaimBars: number;
  /** Use an order-book wall on the absorber side as an alternative entry confirm. */
  useWall: boolean;
  /** Trailing exit: on tagging the partial target, move stop to BE and run to VWAP. */
  useTrail: boolean;
}

interface PosState {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  entryTs: number;
  /** Trail mode: partial target tagged → stop moved to breakeven, running to VWAP. */
  targetTagged?: boolean;
}

export class AuctionReversion {
  private state = new Map<string, PosState>();
  private lastExitTs = new Map<string, number>();

  constructor(private readonly cfg: AuctionConfig) {}

  /** Decide what to do for `coin` given the latest price + signals + book OBI. */
  onUpdate(
    coin: string,
    price: number,
    signals: AuctionSignals,
    obi: number,
    nowTs: number,
    walls?: Walls,
  ): AuctionIntent {
    if (!Number.isFinite(price) || price <= 0) return hold("bad price");
    if (!signals.warm()) return hold("signals not warm");

    const b = signals.bands();
    if (b.sd <= 0 || b.vwap <= 0) return hold("no value area yet");

    const st = this.state.get(coin);
    if (st) return this.manageExit(coin, price, b.vwap, signals, nowTs, st);

    return this.lookForEntry(coin, price, b, signals, obi, nowTs, walls);
  }

  private manageExit(
    coin: string,
    price: number,
    vwap: number,
    signals: AuctionSignals,
    nowTs: number,
    st: PosState,
  ): AuctionIntent {
    const rvol = signals.rvol();
    const delta = signals.recentDelta();
    // Take-profit at a fraction of the way back to current fair value (VWAP).
    // From a 2σ extreme, full mean-reversion to VWAP is rare; capturing ~60%
    // of it converts far more trades into wins. (entry < vwap for longs and
    // entry > vwap for shorts, so this floats correctly for both sides.)
    const target = st.entry + this.cfg.targetReversion * (vwap - st.entry);
    // The acceptance-against cut only fires AFTER a grace period (so we don't
    // bail on the residual flow that produced the entry) AND only while the
    // position is not yet in profit (a volume spike in our favour isn't a cut).
    const graceOver = nowTs - st.entryTs >= this.cfg.exitGraceMs;

    if (st.side === "LONG") {
      if (this.cfg.useTrail) {
        // Tag the partial target → lock breakeven and let the winner run to VWAP.
        if (!st.targetTagged && price >= target) {
          st.targetTagged = true;
          if (st.entry > st.stop) st.stop = st.entry;
        }
        if (st.targetTagged && price >= vwap) {
          return this.exit(coin, "LONG", "target reached (full)", nowTs, {
            maker: this.cfg.useMaker,
            limitPrice: vwap,
          });
        }
      } else if (price >= target) {
        return this.exit(coin, "LONG", "target reached", nowTs, {
          maker: this.cfg.useMaker,
          limitPrice: target,
        });
      }
      if (price <= st.stop) return this.exit(coin, "LONG", "stop", nowTs);
      if (graceOver && price <= st.entry && rvol >= this.cfg.rvolFailExit && delta < 0) {
        return this.exit(coin, "LONG", "acceptance against (breakdown)", nowTs);
      }
    } else {
      if (this.cfg.useTrail) {
        if (!st.targetTagged && price <= target) {
          st.targetTagged = true;
          if (st.entry < st.stop) st.stop = st.entry;
        }
        if (st.targetTagged && price <= vwap) {
          return this.exit(coin, "SHORT", "target reached (full)", nowTs, {
            maker: this.cfg.useMaker,
            limitPrice: vwap,
          });
        }
      } else if (price <= target) {
        return this.exit(coin, "SHORT", "target reached", nowTs, {
          maker: this.cfg.useMaker,
          limitPrice: target,
        });
      }
      if (price >= st.stop) return this.exit(coin, "SHORT", "stop", nowTs);
      if (graceOver && price >= st.entry && rvol >= this.cfg.rvolFailExit && delta > 0) {
        return this.exit(coin, "SHORT", "acceptance against (breakout)", nowTs);
      }
    }

    if (nowTs - st.entryTs >= this.cfg.maxHoldMs) {
      return this.exit(coin, st.side, "time stop", nowTs);
    }
    return hold("in position");
  }

  private lookForEntry(
    coin: string,
    price: number,
    b: ReturnType<AuctionSignals["bands"]>,
    signals: AuctionSignals,
    obi: number,
    nowTs: number,
    walls: Walls | undefined,
  ): AuctionIntent {
    const lastExit = this.lastExitTs.get(coin) ?? -Infinity;
    if (nowTs - lastExit < this.cfg.cooldownMs) return hold("cooldown");

    const upper = this.cfg.bandK === 2 ? b.upper2 : b.upper1;
    const lower = this.cfg.bandK === 2 ? b.lower2 : b.lower1;
    const rvol = signals.rvol();
    const delta = signals.recentDelta();

    // Regime: skip fades that fight the VWAP trend (fade only in range / with trend).
    const slope = this.cfg.useRegime ? signals.vwapSlopeBps(this.cfg.regimeBars) : 0;
    const trendingUp = slope > this.cfg.trendSlopeBps;
    const trendingDown = slope < -this.cfg.trendSlopeBps;

    // CVD/price divergence: price one way while aggressor CVD the other → absorption.
    let bearishDiv = false;
    let bullishDiv = false;
    if (this.cfg.useDivergence) {
      const priceAgo = signals.priceNBarsAgo(this.cfg.divergenceBars);
      const cvdChange = signals.recentDelta(this.cfg.divergenceBars);
      const priceChange = priceAgo > 0 ? price - priceAgo : 0;
      bearishDiv = priceChange > 0 && cvdChange < 0;
      bullishDiv = priceChange < 0 && cvdChange > 0;
    }

    // Location trigger: trapped-reclaim (broke beyond band then reclaimed back
    // inside = failed breakout) when enabled, else the simple at-band touch.
    let shortTrigger: boolean;
    let longTrigger: boolean;
    if (this.cfg.useTrapped) {
      const pAgo = signals.priceNBarsAgo(this.cfg.reclaimBars);
      shortTrigger = pAgo >= upper && price < upper; // broke above VAH → reclaimed
      longTrigger = pAgo > 0 && pAgo <= lower && price > lower; // broke below VAL → reclaimed
    } else {
      shortTrigger = price >= upper;
      longTrigger = price <= lower;
    }

    // Candidate SHORT fade
    if (shortTrigger) {
      if (this.cfg.useRegime && trendingUp) return hold("regime: up-trend, skip short");
      if (rvol > this.cfg.rvolAcceptMax) return hold("acceptance up — no fade (Law 3)");
      const divOk = this.cfg.useDivergence
        ? bearishDiv
        : delta <= -this.cfg.deltaConfirm || obi <= -this.cfg.obiConfirm;
      const wallOk = this.cfg.useWall && walls?.askWall === true;
      if (!(divOk || wallOk)) return hold("no reversal confirm (short)");
      const entry = upper; // maker limit at the value-area edge
      const stop = entry + this.cfg.stopSigma * b.sd;
      this.state.set(coin, { side: "SHORT", entry, stop, entryTs: nowTs });
      return {
        action: "enter_short",
        side: "SELL",
        reason: this.cfg.useTrapped
          ? "trapped longs: reclaim below VAH → short"
          : "failed auction at VAH → fade short",
        maker: this.cfg.useMaker,
        limitPrice: entry,
      };
    }

    // Candidate LONG fade
    if (longTrigger) {
      if (this.cfg.useRegime && trendingDown) return hold("regime: down-trend, skip long");
      if (rvol > this.cfg.rvolAcceptMax) return hold("acceptance down — no fade (Law 3)");
      const divOk = this.cfg.useDivergence
        ? bullishDiv
        : delta >= this.cfg.deltaConfirm || obi >= this.cfg.obiConfirm;
      const wallOk = this.cfg.useWall && walls?.bidWall === true;
      if (!(divOk || wallOk)) return hold("no reversal confirm (long)");
      const entry = lower;
      const stop = entry - this.cfg.stopSigma * b.sd;
      this.state.set(coin, { side: "LONG", entry, stop, entryTs: nowTs });
      return {
        action: "enter_long",
        side: "BUY",
        reason: this.cfg.useTrapped
          ? "trapped shorts: reclaim above VAL → long"
          : "failed auction at VAL → fade long",
        maker: this.cfg.useMaker,
        limitPrice: entry,
      };
    }

    return hold("inside value");
  }

  private exit(
    coin: string,
    side: "LONG" | "SHORT",
    reason: string,
    nowTs: number,
    opts: { maker?: boolean; limitPrice?: number } = {},
  ): AuctionIntent {
    this.state.delete(coin);
    this.lastExitTs.set(coin, nowTs);
    // Closing a LONG = SELL, closing a SHORT = BUY.
    return {
      action: "exit",
      side: side === "LONG" ? "SELL" : "BUY",
      reason,
      maker: opts.maker,
      limitPrice: opts.limitPrice,
    };
  }

  /** Revert an optimistic entry whose fill did not actually execute. */
  abort(coin: string): void {
    this.state.delete(coin);
  }

  /** Current FSM position for a coin (telemetry / tests). */
  getState(coin: string): Readonly<PosState> | undefined {
    const s = this.state.get(coin);
    return s ? { ...s } : undefined;
  }
}

function hold(reason: string): AuctionIntent {
  return { action: "hold", reason };
}
