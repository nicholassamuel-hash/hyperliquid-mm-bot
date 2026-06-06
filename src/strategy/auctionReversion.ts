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
import type { Side } from "../types.js";

export type AuctionAction = "enter_long" | "enter_short" | "exit" | "hold";

export interface AuctionIntent {
  action: AuctionAction;
  reason: string;
  /** Side of the position being opened/closed (for the executor). */
  side?: Side;
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
}

interface PosState {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  entryTs: number;
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
  ): AuctionIntent {
    if (!Number.isFinite(price) || price <= 0) return hold("bad price");
    if (!signals.warm()) return hold("signals not warm");

    const b = signals.bands();
    if (b.sd <= 0 || b.vwap <= 0) return hold("no value area yet");

    const st = this.state.get(coin);
    if (st) return this.manageExit(coin, price, b.vwap, signals, nowTs, st);

    return this.lookForEntry(coin, price, b, signals, obi, nowTs);
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

    if (st.side === "LONG") {
      if (price >= vwap) return this.exit(coin, "LONG", "target: reverted to VWAP", nowTs);
      if (price <= st.stop) return this.exit(coin, "LONG", "stop", nowTs);
      if (rvol >= this.cfg.rvolFailExit && delta < 0) {
        return this.exit(coin, "LONG", "acceptance against (breakdown)", nowTs);
      }
    } else {
      if (price <= vwap) return this.exit(coin, "SHORT", "target: reverted to VWAP", nowTs);
      if (price >= st.stop) return this.exit(coin, "SHORT", "stop", nowTs);
      if (rvol >= this.cfg.rvolFailExit && delta > 0) {
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
  ): AuctionIntent {
    const lastExit = this.lastExitTs.get(coin) ?? -Infinity;
    if (nowTs - lastExit < this.cfg.cooldownMs) return hold("cooldown");

    const upper = this.cfg.bandK === 2 ? b.upper2 : b.upper1;
    const lower = this.cfg.bandK === 2 ? b.lower2 : b.lower1;
    const rvol = signals.rvol();
    const delta = signals.recentDelta();

    // Stretched ABOVE value → candidate SHORT fade
    if (price >= upper) {
      if (rvol > this.cfg.rvolAcceptMax) return hold("acceptance up — no fade (Law 3)");
      const sellersIn = delta <= -this.cfg.deltaConfirm || obi <= -this.cfg.obiConfirm;
      if (!sellersIn) return hold("no reversal confirm (short)");
      const stop = price + this.cfg.stopSigma * b.sd;
      this.state.set(coin, { side: "SHORT", entry: price, stop, entryTs: nowTs });
      return { action: "enter_short", side: "SELL", reason: "failed auction at VAH → fade short" };
    }

    // Stretched BELOW value → candidate LONG fade
    if (price <= lower) {
      if (rvol > this.cfg.rvolAcceptMax) return hold("acceptance down — no fade (Law 3)");
      const buyersIn = delta >= this.cfg.deltaConfirm || obi >= this.cfg.obiConfirm;
      if (!buyersIn) return hold("no reversal confirm (long)");
      const stop = price - this.cfg.stopSigma * b.sd;
      this.state.set(coin, { side: "LONG", entry: price, stop, entryTs: nowTs });
      return { action: "enter_long", side: "BUY", reason: "failed auction at VAL → fade long" };
    }

    return hold("inside value");
  }

  private exit(coin: string, side: "LONG" | "SHORT", reason: string, nowTs: number): AuctionIntent {
    this.state.delete(coin);
    this.lastExitTs.set(coin, nowTs);
    // Closing a LONG = SELL, closing a SHORT = BUY.
    return { action: "exit", side: side === "LONG" ? "SELL" : "BUY", reason };
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
