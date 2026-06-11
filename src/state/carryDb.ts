/**
 * SQLite persistence for the funding-carry paper bot (data/carry.db).
 *
 * Tables:
 *   legs     — one row per coin: current position state + entry marks + fees
 *   accruals — one row per settled funding interval actually collected
 *   basis    — periodic two-leg mark snapshots (the hedge-quality measurement)
 *   events   — enter/exit/guard actions with reasons
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface CarryLeg {
  coin: string;
  status: "in" | "out";
  entryTs: number;
  entrySpot: number;
  entryPerp: number;
  notional: number;
  lastAccruedTs: number;
  feesPaid: number;
}

export class CarryDB {
  private db: DatabaseSync;

  constructor(filepath = "data/carry.db") {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS legs (
        coin TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        entry_ts INTEGER NOT NULL,
        entry_spot REAL NOT NULL,
        entry_perp REAL NOT NULL,
        notional REAL NOT NULL,
        last_accrued_ts INTEGER NOT NULL,
        fees_paid REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS accruals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        ts INTEGER NOT NULL,
        rate REAL NOT NULL,
        amount REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accruals_coin_ts ON accruals(coin, ts);

      CREATE TABLE IF NOT EXISTS basis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        ts INTEGER NOT NULL,
        spot_mid REAL NOT NULL,
        perp_mark REAL NOT NULL,
        basis_bps REAL NOT NULL,
        basis_pnl REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_basis_coin_ts ON basis(coin, ts);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  getLeg(coin: string): CarryLeg | undefined {
    const row = this.db
      .prepare(
        `SELECT coin, status, entry_ts AS entryTs, entry_spot AS entrySpot,
                entry_perp AS entryPerp, notional, last_accrued_ts AS lastAccruedTs,
                fees_paid AS feesPaid
         FROM legs WHERE coin = ?`,
      )
      .get(coin) as unknown as CarryLeg | undefined;
    return row;
  }

  upsertLeg(leg: CarryLeg) {
    this.db
      .prepare(
        `INSERT INTO legs (coin, status, entry_ts, entry_spot, entry_perp, notional, last_accrued_ts, fees_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(coin) DO UPDATE SET
           status=excluded.status, entry_ts=excluded.entry_ts,
           entry_spot=excluded.entry_spot, entry_perp=excluded.entry_perp,
           notional=excluded.notional, last_accrued_ts=excluded.last_accrued_ts,
           fees_paid=excluded.fees_paid`,
      )
      .run(leg.coin, leg.status, leg.entryTs, leg.entrySpot, leg.entryPerp, leg.notional, leg.lastAccruedTs, leg.feesPaid);
  }

  recordAccrual(coin: string, ts: number, rate: number, amount: number) {
    this.db
      .prepare(`INSERT INTO accruals (coin, ts, rate, amount) VALUES (?, ?, ?, ?)`)
      .run(coin, ts, rate, amount);
  }

  recordBasis(coin: string, ts: number, spotMid: number, perpMark: number, basisBps: number, basisPnl: number) {
    this.db
      .prepare(`INSERT INTO basis (coin, ts, spot_mid, perp_mark, basis_bps, basis_pnl) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(coin, ts, spotMid, perpMark, basisBps, basisPnl);
  }

  recordEvent(coin: string, ts: number, type: string, detail: string) {
    this.db.prepare(`INSERT INTO events (coin, ts, type, detail) VALUES (?, ?, ?, ?)`).run(coin, ts, type, detail);
  }

  /** Aggregates for the report CLI. */
  summary() {
    const legs = this.db
      .prepare(
        `SELECT coin, status, entry_ts AS entryTs, entry_spot AS entrySpot, entry_perp AS entryPerp,
                notional, fees_paid AS feesPaid FROM legs ORDER BY coin`,
      )
      .all() as unknown as Array<Omit<CarryLeg, "lastAccruedTs">>;
    const accr = this.db
      .prepare(
        `SELECT coin, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total,
                MIN(ts) AS firstTs, MAX(ts) AS lastTs
         FROM accruals GROUP BY coin`,
      )
      .all() as unknown as Array<{ coin: string; n: number; total: number; firstTs: number; lastTs: number }>;
    const lastBasis = this.db
      .prepare(
        `SELECT b.coin, b.ts, b.basis_bps AS basisBps, b.basis_pnl AS basisPnl
         FROM basis b JOIN (SELECT coin, MAX(ts) AS mts FROM basis GROUP BY coin) m
           ON b.coin = m.coin AND b.ts = m.mts`,
      )
      .all() as unknown as Array<{ coin: string; ts: number; basisBps: number; basisPnl: number }>;
    const events = this.db
      .prepare(`SELECT coin, ts, type, detail FROM events ORDER BY ts DESC LIMIT 20`)
      .all() as unknown as Array<{ coin: string; ts: number; type: string; detail: string }>;
    return { legs, accr, lastBasis, events };
  }

  close() {
    this.db.close();
  }
}
