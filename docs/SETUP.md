# Phase 2 Activation Checklist

When you've validated Phase 1 (paper) and want to go live with $30, work through this in order. Do NOT skip steps.

## Pre-flight (do these BEFORE any code change)

- [ ] Paper trader ran for ≥ 24 hours with positive simulated P&L
- [ ] Adverse selection rate < 30% of fills
- [ ] You understand exactly which market(s) you're going to trade and why
- [ ] You have $30 of "lose-able money" — treat as tuition, not capital
- [ ] You can lose 100% without affecting your life

## Wallet & funding

- [ ] Created a **brand new** Polygon wallet (MetaMask or Rabby) — DO NOT reuse personal wallet
  - Reason: bot will have access to the private key. Isolate blast radius.
- [ ] Saved seed phrase offline (paper, not in any digital form)
- [ ] Wallet address: `0x________________________________________`
- [ ] Funded wallet with:
  - MATIC (for gas) — $1 worth is plenty
  - USDC (Polygon native) — $30
- [ ] Verified balances on https://polygonscan.com/address/YOUR_ADDRESS

## Polymarket account

- [ ] Visited https://polymarket.com from your normal browser
- [ ] Connected the NEW bot wallet (not personal)
- [ ] Accepted terms manually (I will not click ToS for you)
- [ ] Deposited USDC into Polymarket (uses pUSD now per CLOB V2)
- [ ] Verified you can see balance on the Polymarket UI

## Bot configuration

- [ ] Filled `.env`:
  ```
  WALLET_PRIVATE_KEY=0x...          # The NEW wallet's private key
  WALLET_ADDRESS=0x...              # Same address you used above
  CLOB_HOST=https://clob.polymarket.com
  POLYGON_RPC=https://...           # Free RPC OK to start, upgrade later
  ```
- [ ] `.env` is **not** in git (verify: `git status` should not show it)
- [ ] Tightened risk params for live mode:
  - `MAX_POSITION=2`           — really small at start
  - `MAX_INVENTORY_USD=4`      — limits worst-case loss
  - `HALF_SPREAD=0.03`         — wider = safer (less likely to be adversely selected)

## Code changes

- [ ] Implement `createLiveClient()` in `src/client/clob.ts` (currently throws)
  - Reference implementation is in the doc comment of that function
- [ ] Add `src/sim/runLive.ts` that:
  - Uses live ClobClient
  - Places real orders via `createAndPostOrder`
  - Cancels via `cancelOrder`
  - All other logic identical to `runPaper.ts`
- [ ] Add `npm run live` script to `package.json`
- [ ] Run `npm run typecheck` clean
- [ ] All tests still pass: `npm test`

## Hosting

- [ ] Decide where to run:
  - **Option A**: Your laptop (cheap, but goes offline)
  - **Option B**: VPS Singapore ($5/mo Vultr/Hetzner) — lower latency, always-on
  - **Recommended**: Option B
- [ ] If VPS:
  - Provisioned with Ubuntu 24.04, Node 22+
  - SSH key auth only (no password)
  - UFW firewall enabled
  - Bot user account (not root)
  - Bot installed via git clone (you push code) or rsync from laptop
- [ ] PM2 or systemd configured for auto-restart
- [ ] Log rotation set up

## Day 0 live test

- [ ] Start bot with **smallest possible quote size** (1 share = $0.01-$0.99 per side)
- [ ] Watch live for 30 minutes
- [ ] Verify orders are appearing on Polymarket UI
- [ ] Verify cancellations also work
- [ ] Verify fills update balance correctly
- [ ] Check fees match what your code expects

## Kill switch

Make sure you know how to immediately stop the bot:

- [ ] On laptop: Ctrl+C, then `npm run cancel-all` (you need to write this)
- [ ] On VPS: `pm2 stop polymarket-bot && ssh ... 'node cancel-all.js'`
- [ ] Manually on Polymarket UI: cancel all open orders

## Week 1 monitoring

- [ ] Daily check: P&L, win rate, adverse rate, fee total
- [ ] If down > 50% of initial: STOP and reflect
- [ ] If down > 75%: STOP, do not increase modal
- [ ] If up > 100%: still keep position small; profitability ≠ statistical significance over short windows

## Red flags — STOP immediately if any of these happen

- [ ] Bot placed orders you didn't authorize parameters for
- [ ] Bot loses > 20% in single day
- [ ] You can't account for where your USDC went
- [ ] Polymarket UI shows orders that don't match bot logs
- [ ] You feel anxious checking the bot

The last one is the most important. If you find yourself checking compulsively or stressed, stop. The bot is supposed to remove stress, not add it.
