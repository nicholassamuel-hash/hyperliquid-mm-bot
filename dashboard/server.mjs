// Local dashboard for the Hyperliquid auction bot.
// Runs on YOUR machine, SSH-reads ~/bot/data/state.json from the VPS, and serves
// a live auto-refreshing page. Local-only — opens no ports on the VPS.
//
//   node dashboard/server.mjs            →  http://localhost:8787
//   PORT=9000 node dashboard/server.mjs  →  custom port
//
// Env overrides: BOT_HOST, BOT_KEY, BOT_STATE, PORT.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.BOT_HOST || "root@202.155.132.247";
const KEY =
  process.env.BOT_KEY ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".ssh", "neva-bot");
const REMOTE = process.env.BOT_STATE || "~/bot/data/state.json";
const PORT = Number(process.env.PORT || 8787);

let cache = { at: 0, data: null };

function fetchState() {
  return new Promise((resolve) => {
    if (cache.data && Date.now() - cache.at < 3000) return resolve(cache.data);
    execFile(
      "ssh",
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-i", KEY, HOST, `cat ${REMOTE}`],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          return resolve(cache.data || { error: "no state yet — bot warming up (~30m), or SSH failed" });
        }
        try {
          const d = JSON.parse(stdout);
          cache = { at: Date.now(), data: d };
          resolve(d);
        } catch {
          resolve(cache.data || { error: "could not parse state.json" });
        }
      },
    );
  });
}

http
  .createServer(async (req, res) => {
    if (req.url && req.url.startsWith("/api/state")) {
      const d = await fetchState();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(d));
      return;
    }
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(path.join(__dirname, "index.html")));
    } catch {
      res.writeHead(500);
      res.end("index.html missing");
    }
  })
  .listen(PORT, () => {
    console.log(`\n  Auction bot dashboard -> http://localhost:${PORT}`);
    console.log(`  (SSH-reading ${HOST}:${REMOTE})\n`);
  });
