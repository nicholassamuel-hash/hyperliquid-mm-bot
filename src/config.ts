/**
 * Centralized config loaded from env. Fails fast on invalid input.
 */
import "dotenv/config";
import { z } from "zod";

/**
 * Parse a per-coin quote-size map from env.
 * Format: "BTC:2,ETH:1.5,SOL:2" → { BTC: 2, ETH: 1.5, SOL: 2 }.
 * Coin keys are upper-cased. Empty string → {}. Throws on malformed entries
 * (bad shape, empty coin, non-positive/non-finite size) so config fails fast.
 */
export function parseCoinSizeMap(raw: string): Record<string, number> {
  const map: Record<string, number> = {};
  const trimmed = raw.trim();
  if (trimmed === "") return map;
  for (const part of trimmed.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    const idx = seg.indexOf(":");
    if (idx === -1) throw new Error(`Invalid entry "${seg}" (expected COIN:SIZE)`);
    const coin = seg.slice(0, idx).trim().toUpperCase();
    const val = Number(seg.slice(idx + 1).trim());
    if (coin === "") throw new Error(`Empty coin in "${seg}"`);
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`Invalid size for ${coin} in "${seg}" (must be a number > 0)`);
    }
    map[coin] = val;
  }
  return map;
}

const schema = z.object({
  COINS: z
    .string()
    .min(1, "COINS required")
    .transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean)),

  WALLET_PRIVATE_KEY: z.string().optional(),
  WALLET_ADDRESS: z.string().optional(),

  // --- Strategy ---
  QUOTE_MODE: z.enum(["join", "improve", "outside"]).default("improve"),

  /** Floor on half-spread bps (used when computing edge gate). */
  HALF_SPREAD_BPS_MIN: z.coerce.number().min(0.5).default(1.5),
  /** Cap on half-spread bps. */
  HALF_SPREAD_BPS_MAX: z.coerce.number().min(1).default(20),
  /** Multiplier from realized vol to effective half-spread. */
  VOL_MULTIPLIER: z.coerce.number().min(0.1).default(1.5),

  QUOTE_SIZE_USD: z.coerce.number().min(0.1).default(0.5),
  /**
   * Per-coin quote-size overrides (USD), format "BTC:2,ETH:2,SOL:2,HYPE:1.5".
   * Falls back to QUOTE_SIZE_USD for any coin not listed. Lets expensive coins
   * (BTC/ETH) clear their min size — a single QUOTE_SIZE_USD floors to 0 once
   * price is high enough (e.g. $0.5/BTC rounds below min above ~$100k).
   */
  QUOTE_SIZE_USD_BY_COIN: z
    .string()
    .default("")
    .transform((s, ctx) => {
      try {
        return parseCoinSizeMap(s);
      } catch (e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
        return z.NEVER;
      }
    }),
  MAX_POSITION_USD: z.coerce.number().min(1).default(20),
  MAX_MARGIN_USD: z.coerce.number().min(1).default(15),
  REPLACE_COOLDOWN_MS: z.coerce.number().min(50).default(200),

  ADVERSE_THRESHOLD_BPS_MIN: z.coerce.number().min(0.5).default(1.5),
  /**
   * Bps the opposite touch must move PAST our quote before we cancel as stale.
   * 0 = twitchy legacy guard (cancels on first touch + drift early-warning) —
   * in join mode that fires on ~every tick → ~80% adverse rate, starved fills.
   * >0 (e.g. 2) lets quotes rest through normal oscillation and disables the
   * drift check (which over-fires when threshold >> natural spread).
   */
  ADVERSE_STALE_TOLERANCE_BPS: z.coerce.number().min(0).default(0),
  FUNDING_SKEW_THRESHOLD: z.coerce.number().min(0).default(0.0001),

  /** Min edge in bps after fees needed to bother quoting. */
  MIN_EDGE_BPS: z.coerce.number().default(0.5),

  /** OBI weight 0-1 (0 = ignore, 1 = full skew). */
  OBI_WEIGHT: z.coerce.number().min(0).max(1).default(0.5),
  /** Inventory flat-bias weight 0-1. */
  INV_FLAT_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),

  /** Vol spike detection: pause when shortVol/baselineVol > multiplier. */
  VOL_SPIKE_MULTIPLIER: z.coerce.number().min(1).default(3),
  /** Short-window bar count for spike detection. */
  VOL_SPIKE_SHORT_BARS: z.coerce.number().int().min(2).default(5),
  /** Baseline window bar count. Must be >= 10. */
  VOL_SPIKE_BASELINE_BARS: z.coerce.number().int().min(10).default(30),
  /** Pause duration (ms) after spike detection. */
  VOL_PAUSE_MS: z.coerce.number().int().min(1000).default(60_000),

  // --- Auction reversion strategy (npm run auction) ---
  /** Position size per trade in USD (taker entries). */
  AUCTION_SIZE_USD: z.coerce.number().min(0.1).default(5),
  /** Which σ band marks the value-area edge to fade (1 or 2). */
  AUCTION_BAND_K: z.coerce.number().int().min(1).max(2).default(2),
  /** Trade-bar interval (ms) for signal aggregation. */
  AUCTION_BAR_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Rolling VWAP/band window length in bars. */
  AUCTION_WINDOW_BARS: z.coerce.number().int().min(10).default(240),
  /** Completed bars required before trading. */
  AUCTION_WARM_BARS: z.coerce.number().int().min(2).default(30),
  /** RVOL above this = acceptance → do not fade. */
  AUCTION_RVOL_ACCEPT_MAX: z.coerce.number().min(1).default(1.8),
  /** Min |recentDelta| in reversal direction to confirm (0 = sign only). */
  AUCTION_DELTA_CONFIRM: z.coerce.number().min(0).default(0),
  /** Min |OBI| in reversal direction as alternative confirmation. */
  AUCTION_OBI_CONFIRM: z.coerce.number().min(0).max(1).default(0.15),
  /** Stop placed this many σ beyond entry. */
  AUCTION_STOP_SIGMA: z.coerce.number().min(0.1).default(1),
  /** Time stop (ms) for an open position. */
  AUCTION_MAX_HOLD_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  /** Cooldown (ms) after an exit before re-entry. */
  AUCTION_COOLDOWN_MS: z.coerce.number().int().min(0).default(60_000),
  /** RVOL against an open position above this = acceptance, cut. */
  AUCTION_RVOL_FAIL_EXIT: z.coerce.number().min(1).default(3),
  /** Grace period (ms) after entry before the acceptance-against cut may fire. */
  AUCTION_EXIT_GRACE_MS: z.coerce.number().int().min(0).default(120_000),
  /** Take-profit at this fraction of the reversion toward VWAP (1 = full VWAP). */
  AUCTION_TARGET_REVERSION: z.coerce.number().min(0.1).max(1).default(0.6),
  /** Use CVD/price divergence as the entry confirmation (stricter). Default off. */
  AUCTION_USE_DIVERGENCE: z.string().default("false").transform((s) => s.toLowerCase() === "true"),
  /** Lookback bars for the price-vs-CVD divergence check. */
  AUCTION_DIVERGENCE_BARS: z.coerce.number().int().min(2).default(5),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid config:", JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }
  return parsed.data;
}
