# Deployment Guide

Three deployment paths, ordered by complexity:

## Option 1: Local laptop (easiest, not recommended for live)

```bash
npm install
npm run build
npm run paper      # or `npm run live` after .env wired
```

Pros: zero infra. Cons: laptop offline → bot offline.

---

## Option 2: VPS with PM2 (recommended for live)

### 2.1 Provision VPS
- Provider: Vultr, Hetzner, or DigitalOcean
- Region: **Singapore** (lowest latency from Indonesia, ~30ms)
- Specs: 1 vCPU, 1GB RAM, 25GB SSD ($5-6/month is enough)
- OS: Ubuntu 24.04 LTS

### 2.2 Initial setup
```bash
ssh root@<vps-ip>

# Update + non-root user
adduser bot
usermod -aG sudo bot
su - bot

# Install Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm i -g pm2

# Firewall (SSH only)
sudo ufw allow OpenSSH && sudo ufw enable
```

### 2.3 Deploy bot
```bash
git clone <your-repo-url> bot
cd bot
npm ci
npm run build

# Set up env (DO NOT commit .env)
cp .env.example .env
nano .env  # set COINS, params; do NOT add wallet key in paper mode

# Start paper trader as PM2 process
pm2 start ecosystem.config.cjs --only paper
pm2 startup    # follow the printed instruction
pm2 save
```

### 2.4 Going live
1. On laptop: `npm run gen-wallet` (creates `.env.wallet` locally; NEVER upload to VPS)
2. Back up `.env.wallet` to encrypted USB / password manager
3. Fund the address with USDC on Arbitrum, then bridge → Hyperliquid via UI
4. SSH to VPS, edit `.env` and paste private key directly:
   ```
   nano .env
   # paste:
   WALLET_PRIVATE_KEY=0x...
   WALLET_ADDRESS=0x...
   ```
5. Switch to live:
   ```bash
   pm2 stop paper
   DRY_RUN=true pm2 start ecosystem.config.cjs --only live  # dry-run first!
   # observe logs for 30min, verify quote logic
   pm2 stop live
   pm2 start ecosystem.config.cjs --only live   # real
   pm2 save
   ```

### 2.5 Monitoring
```bash
pm2 logs live --lines 100
pm2 monit
# Or run the dashboard:
npm run dashboard
```

### 2.6 Emergency stop
```bash
pm2 stop live
# bot's graceful-shutdown handler will cancel all open orders
# verify in Hyperliquid UI
```

---

## Option 3: Docker (cleanest, more moving parts)

### 3.1 Build & run paper
```bash
docker compose build
docker compose up -d
docker compose logs -f
```

### 3.2 Live mode
Edit `docker-compose.yml` command:
```yaml
    command: ["node", "dist/sim/runLive.js"]
```
Then:
```bash
docker compose down
docker compose up -d
```

### 3.3 Health check
The Dockerfile includes a healthcheck on `data/bot.db`. PM2/orchestrators can read this.

---

## Going-live checklist

- [ ] Paper traded for ≥ 24h with positive net or break-even
- [ ] Adverse rate < 50% (else strategy needs more tuning)
- [ ] Fund a NEW wallet (not personal) with intended modal
- [ ] First live run uses `DRY_RUN=true` for 30+ minutes
- [ ] `MAX_POSITION_USD` and `MAX_MARGIN_USD` set conservatively
- [ ] You know how to kill: `pm2 stop live` or `docker compose down`
- [ ] You've checked the Hyperliquid UI shows your orders & positions match bot logs

## Cost estimates (monthly, USD)

| Item | Cost |
|---|---|
| VPS Vultr Singapore 1GB | $6 |
| Domain (optional) | $1 |
| **Total infra** | **~$7** |

## What goes wrong (and what to do)

| Symptom | Cause | Fix |
|---|---|---|
| `WALLET_PRIVATE_KEY must be a 0x-prefixed...` | Key not 66 chars or missing 0x | Re-generate via `npm run gen-wallet` |
| Pre-flight: account equity <$1 | Not deposited into Hyperliquid yet | Fund + deposit via UI |
| WS connect errors persistent | Network issue or HL outage | Check status.hyperliquid.xyz |
| Many "Bid order failed: insufficient margin" | MAX_POSITION_USD too high vs equity | Lower MAX_POSITION_USD |
| Bot loses >50% in a day | Strategy broken or unlucky regime | Stop, review fills, retune |
