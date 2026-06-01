/**
 * Centralized config loaded from env. Fails fast on invalid input.
 */
import "dotenv/config";
import { z } from "zod";

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

  QUOTE_SIZE_USD: z.coerce.number().min(0.5).default(2),
  MAX_POSITION_USD: z.coerce.number().min(1).default(20),
  MAX_MARGIN_USD: z.coerce.number().min(1).default(15),
  REPLACE_COOLDOWN_MS: z.coerce.number().min(50).default(200),

  ADVERSE_THRESHOLD_BPS_MIN: z.coerce.number().min(0.5).default(1.5),
  FUNDING_SKEW_THRESHOLD: z.coerce.number().min(0).default(0.0001),

  /** Min edge in bps after fees needed to bother quoting. */
  MIN_EDGE_BPS: z.coerce.number().default(0.5),

  /** OBI weight 0-1 (0 = ignore, 1 = full skew). */
  OBI_WEIGHT: z.coerce.number().min(0).max(1).default(0.5),
  /** Inventory flat-bias weight 0-1. */
  INV_FLAT_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),

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
