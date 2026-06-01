#!/usr/bin/env bash
# One-shot deploy script for GCP e2-micro (or any Debian/Ubuntu VM).
# Run on the VM AFTER you've SSH'd in.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<your-repo>/main/scripts/deploy-gcp.sh | bash
#
# Or upload this file & run: bash deploy-gcp.sh
#
# What it does:
#   1. Installs Node.js 22 + git + PM2
#   2. Clones the bot repo (you must edit REPO_URL below or set REPO env)
#   3. Builds the bot
#   4. Prompts for .env values
#   5. Starts paper trader under PM2
#   6. Sets up auto-restart on boot
set -euo pipefail

REPO_URL="${REPO:-https://github.com/palkon/hyperliquid-mm-bot.git}"
BOT_DIR="${BOT_DIR:-$HOME/bot}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Hyperliquid MM Bot — VPS deploy"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# --- 1. System update + deps ---
echo "▶ Updating system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl build-essential

# --- 2. Install Node.js 22 ---
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oP '\d+' | head -1)" -lt 22 ]; then
  echo "▶ Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "✓ Node: $(node -v), npm: $(npm -v)"

# --- 3. Install PM2 ---
if ! command -v pm2 >/dev/null 2>&1; then
  echo "▶ Installing PM2..."
  sudo npm install -g pm2 --silent
fi
echo "✓ PM2: $(pm2 -v)"

# --- 4. Clone or update repo ---
if [ -d "$BOT_DIR/.git" ]; then
  echo "▶ Updating existing repo at $BOT_DIR..."
  git -C "$BOT_DIR" pull --ff-only
else
  echo "▶ Cloning repo to $BOT_DIR..."
  git clone "$REPO_URL" "$BOT_DIR"
fi
cd "$BOT_DIR"

# --- 5. Install bot deps + build ---
echo "▶ Installing bot deps..."
npm ci --silent
echo "▶ Building TypeScript..."
npm run build

# --- 6. Configure .env if missing ---
if [ ! -f .env ]; then
  echo "▶ Creating .env from template..."
  cp .env.example .env
  echo ""
  echo "⚠️  Default .env created. Edit it now if you want non-default settings:"
  echo "   nano .env"
  echo ""
  echo "   (Press Enter to continue with defaults, or Ctrl+C to abort & edit first)"
  read -r
fi

# --- 7. Setup directories ---
mkdir -p data logs recordings

# --- 8. Start under PM2 ---
echo "▶ Starting paper trader under PM2..."
pm2 delete paper 2>/dev/null || true
pm2 start ecosystem.config.cjs --only paper
pm2 save

# --- 9. Setup boot persistence ---
echo "▶ Setting up auto-start on boot..."
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | bash || true
pm2 save

# --- 10. Summary ---
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Bot deployed and running"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Commands you'll use:"
echo "  pm2 logs paper          # tail bot logs"
echo "  pm2 status              # process status"
echo "  pm2 monit               # interactive monitor"
echo "  pm2 restart paper       # restart bot"
echo "  pm2 stop paper          # stop bot"
echo ""
echo "  cd $BOT_DIR && npm run dashboard  # real-time stats"
echo ""
echo "Logs are at: $BOT_DIR/logs/"
echo "Data DB:    $BOT_DIR/data/bot.db"
echo ""
echo "Now: leave it running 24h, come back tomorrow, check the stats."
echo ""
