#!/usr/bin/env tsx
/**
 * Wallet generator — creates a fresh EVM keypair for the bot.
 *
 * Safety:
 *   - Refuses to overwrite an existing .env.wallet
 *   - Writes to .env.wallet (separate from .env, gitignored)
 *   - Prints address (NOT key) to console for funding
 *   - User must manually merge into .env when ready
 *
 * Run: npm run gen-wallet
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const WALLET_FILE = ".env.wallet";

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const filePath = path.resolve(WALLET_FILE);

  if (fs.existsSync(filePath)) {
    console.error(`✗ ${WALLET_FILE} already exists.`);
    console.error("  Refusing to overwrite to avoid losing existing key.");
    console.error(`  If you really want a new wallet, manually delete ${filePath} first.`);
    process.exit(1);
  }

  console.log("⚠️  GENERATING NEW WALLET");
  console.log("");
  console.log("This wallet will be:");
  console.log("  • Brand new (no funds)");
  console.log("  • For BOT USE ONLY — do not reuse personal");
  console.log("  • Stored in .env.wallet (gitignored, never commit)");
  console.log("  • You are 100% responsible for backing up the key");
  console.log("");

  const ok = await confirm("Proceed?");
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const content = `# Generated ${new Date().toISOString()}
# Bot wallet — fund this address with USDC via Arbitrum bridge to Hyperliquid
WALLET_PRIVATE_KEY=${privateKey}
WALLET_ADDRESS=${account.address}
`;

  fs.writeFileSync(filePath, content, { mode: 0o600 });
  console.log("");
  console.log(`✓ Wrote ${WALLET_FILE} (chmod 600)`);
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log(`│ Address: ${account.address.padEnd(50)} │`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Back up .env.wallet to offline storage (e.g. encrypted USB)");
  console.log("  2. Fund the address with USDC on Arbitrum");
  console.log("  3. Visit hyperliquid.xyz and connect this wallet");
  console.log("  4. Deposit USDC into Hyperliquid (uses ArbBridge under the hood)");
  console.log("  5. When ready to go live: merge .env.wallet into .env, then npm run live");
  console.log("");
  console.log("⚠️  Until you actually merge into .env, the bot will NOT use this key.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
