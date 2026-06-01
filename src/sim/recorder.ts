/**
 * Recorder — subscribes to WS and dumps all events to JSONL.
 *
 * Run: npm run record -- BTC,ETH 3600
 * (will record COINS for 3600 seconds, write to recordings/<timestamp>.jsonl)
 */
import fs from "node:fs";
import path from "node:path";
import { HyperliquidWS } from "../client/websocket.js";
import { createLogger } from "../util/logger.js";

interface EventRecord {
  type: "book" | "trade" | "priceChange";
  ts: number;
  data: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npm run record -- COIN[,COIN...] [duration_sec]");
    process.exit(1);
  }
  const coins = args[0]!.split(",").map((s) => s.trim()).filter(Boolean);
  const durationSec = args[1] ? parseInt(args[1], 10) : 3600;

  const log = createLogger("info");
  const recordingsDir = path.resolve("recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = path.join(recordingsDir, `${coins.join("_")}_${ts}.jsonl`);
  const stream = fs.createWriteStream(filename, { flags: "w" });
  let count = 0;

  log.info({ coins, durationSec, file: filename }, "Recording started");

  const ws = new HyperliquidWS(coins, log);

  const writeEvent = (rec: EventRecord) => {
    stream.write(JSON.stringify(rec) + "\n");
    count++;
  };

  ws.on("book", (snap) =>
    writeEvent({ type: "book", ts: snap.timestamp, data: snap }),
  );
  ws.on("priceChange", (e) =>
    writeEvent({ type: "priceChange", ts: e.timestamp, data: e }),
  );
  ws.on("trade", (t) => writeEvent({ type: "trade", ts: t.timestamp, data: t }));

  ws.connect();

  setInterval(() => log.info({ count, file: filename }, "Recording progress"), 30_000);

  setTimeout(() => {
    log.info({ count }, "Recording complete");
    ws.close();
    stream.end(() => process.exit(0));
  }, durationSec * 1000);

  const shutdown = () => {
    log.info({ count }, "Recording stopped (signal)");
    ws.close();
    stream.end(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
