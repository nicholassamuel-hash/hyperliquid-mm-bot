/**
 * SQLite state persistence using Node.js built-in `node:sqlite`.
 * Schema adapted for Hyperliquid perp: coin instead of token_id.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { Fill, OurQuote } from "../types.js";

export class StateDB {
  private db: DatabaseSync;

  constructor(filepath = "data/bot.db") {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        fee REAL NOT NULL,
        ts INTEGER NOT NULL,
        is_paper INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_fills_coin ON fills(coin, ts);

      CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        bid_price REAL NOT NULL,
        bid_size REAL NOT NULL,
        ask_price REAL NOT NULL,
        ask_size REAL NOT NULL,
        placed_at INTEGER NOT NULL,
        replaced_at INTEGER,
        is_paper INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_quotes_coin ON quotes(coin, placed_at);

      CREATE TABLE IF NOT EXISTS daily_pnl (
        date TEXT PRIMARY KEY,
        gross_pnl REAL NOT NULL,
        fees_paid REAL NOT NULL,
        funding_paid REAL NOT NULL,
        n_fills INTEGER NOT NULL,
        is_paper INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_coin_ts ON outcomes(coin, ts);
    `);
  }

  recordOutcome(coin: string, outcome: string, ts: number) {
    this.db
      .prepare(`INSERT INTO outcomes (coin, outcome, ts) VALUES (?, ?, ?)`)
      .run(coin, outcome, ts);
  }

  /** Counters per outcome since timestamp. */
  outcomeStats(sinceMs = 0) {
    const rows = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM outcomes WHERE ts >= ? GROUP BY outcome`,
      )
      .all(sinceMs) as Array<{ outcome: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.outcome] = r.n;
    return counts;
  }

  recordFill(fill: Fill, isPaper = true) {
    this.db
      .prepare(
        `INSERT INTO fills (coin, side, price, size, fee, ts, is_paper) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fill.coin, fill.side, fill.price, fill.size, fill.fee, fill.timestamp, isPaper ? 1 : 0);
  }

  recordQuote(quote: OurQuote, isPaper = true): number {
    const result = this.db
      .prepare(
        `INSERT INTO quotes (coin, bid_price, bid_size, ask_price, ask_size, placed_at, is_paper) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.coin,
        quote.bidPrice,
        quote.bidSize,
        quote.askPrice,
        quote.askSize,
        quote.placedAt,
        isPaper ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  markQuoteReplaced(id: number, replacedAt: number) {
    this.db.prepare(`UPDATE quotes SET replaced_at = ? WHERE id = ?`).run(replacedAt, id);
  }

  getFillsSince(coin: string, sinceMs: number): Fill[] {
    return this.db
      .prepare(
        `SELECT coin, side, price, size, fee, ts as timestamp FROM fills WHERE coin = ? AND ts >= ? ORDER BY ts ASC`,
      )
      .all(coin, sinceMs) as unknown as Fill[];
  }

  stats(sinceMs = 0) {
    return this.db
      .prepare(
        `SELECT
            COUNT(*) AS fills,
            COALESCE(SUM(CASE WHEN side='SELL' THEN size*price ELSE 0 END), 0) AS sellNotional,
            COALESCE(SUM(CASE WHEN side='BUY' THEN size*price ELSE 0 END), 0) AS buyNotional,
            COALESCE(SUM(fee), 0) AS totalFees
         FROM fills WHERE ts >= ?`,
      )
      .get(sinceMs) as unknown as {
      fills: number;
      sellNotional: number;
      buyNotional: number;
      totalFees: number;
    };
  }

  close() {
    this.db.close();
  }
}
