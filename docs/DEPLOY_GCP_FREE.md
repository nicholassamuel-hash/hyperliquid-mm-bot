# Deploy ke GCP Free Tier — 20 menit step-by-step

## Yang Anda butuhkan
- Akun Google (Gmail biasa OK)
- Credit/debit card untuk verifikasi (TIDAK akan kena charge selama dalam free tier)
- Terminal dengan SSH (Windows: Powershell sudah punya `ssh`)

## Free tier yang dipakai
- VM: `e2-micro` di region US (us-west1 atau us-central1)
- 1 vCPU, 1 GB RAM, 30 GB disk
- 1 GB egress per bulan (cukup untuk bot kita)
- **Selamanya gratis** asal stay di limit

---

## Step 1 — Sign up GCP (5 menit)

1. Buka https://console.cloud.google.com
2. Login dengan Google account
3. Setuju Terms of Service
4. Masukkan info pembayaran (CC/debit) — verifikasi ID, tidak charge
5. Klik "Start free trial" — Anda dapat $300 credit + Always Free tier

## Step 2 — Create VM e2-micro (5 menit)

1. Buka https://console.cloud.google.com/compute/instances
2. Klik **"Create Instance"**
3. Isi:
   - **Name**: `mm-bot`
   - **Region**: `us-west1` (Oregon — paling cepat ke Hyperliquid US)
   - **Zone**: `us-west1-a`
   - **Machine config**: pilih tab "E2", **machine type `e2-micro`** (penting! Hanya e2-micro yang Always Free)
   - **Boot disk**:
     - OS: **Ubuntu**
     - Version: **Ubuntu 24.04 LTS**
     - Size: **30 GB** (max free)
   - **Firewall**: centang "Allow HTTP traffic" (optional, untuk future dashboard)
4. Klik **"Create"** — tunggu 30 detik

## Step 3 — SSH ke VM (1 menit)

Cara A (paling gampang) — klik **"SSH"** di sebelah nama VM di console. Browser membuka terminal langsung.

Cara B — pakai gcloud CLI:
```bash
gcloud compute ssh mm-bot --zone us-west1-a
```

## Step 4 — Push repo ke GitHub (5 menit)

Bot perlu di-clone ke VM. Caranya: push codebase Anda ke GitHub dulu.

Di **laptop Windows** Anda:
```powershell
cd C:\Users\palkon\Documents\polymarket-bot

# Setup git remote — ganti <your-username> dengan username GitHub Anda
# Buat repo kosong dulu di https://github.com/new (private OK)
git remote add origin https://github.com/<your-username>/hyperliquid-mm-bot.git
git branch -M main
git push -u origin main
```

Kalau belum punya GitHub account atau gak mau push public:
- Buat private repo di GitHub (gratis)
- Atau pakai GitLab/Bitbucket
- Atau upload ZIP manual ke VM via `scp`

## Step 5 — Deploy di VM (5 menit)

Setelah SSH ke VM, jalanin:

```bash
# Download deploy script + run (otomatis install Node, PM2, clone, build, start)
export REPO=https://github.com/<your-username>/hyperliquid-mm-bot.git
curl -fsSL "$REPO/raw/main/scripts/deploy-gcp.sh" | bash
```

**Atau manual** kalau script gagal:
```bash
# 1. Install Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git build-essential

# 2. Install PM2
sudo npm install -g pm2

# 3. Clone
git clone https://github.com/<your-username>/hyperliquid-mm-bot.git
cd hyperliquid-mm-bot

# 4. Build
npm ci && npm run build

# 5. Config
cp .env.example .env
# Default COINS=HYPE — edit kalau perlu: nano .env

# 6. Start under PM2
mkdir -p data logs
pm2 start ecosystem.config.cjs --only paper
pm2 save

# 7. Auto-restart on boot
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME
pm2 save
```

## Step 6 — Verify bot jalan

```bash
# Status
pm2 status

# Tail logs
pm2 logs paper

# Real-time dashboard
cd ~/hyperliquid-mm-bot && npm run dashboard
```

Anda harusnya lihat:
- `pm2 status`: ✓ paper online
- `pm2 logs paper`: `WS connected, subscribing`, `Market context refreshed`
- Setelah ~30 detik: `Periodic stats fills: 0/0...`

## Step 7 — Tunggu 24 jam, log out

Anda bisa close SSH window, bot tetap jalan. Besok:
```bash
ssh ... (atau SSH via console)
cd ~/hyperliquid-mm-bot
npm run dashboard
```

Atau dari laptop, lihat stats remotely:
```bash
ssh mm-bot 'sqlite3 ~/hyperliquid-mm-bot/data/bot.db "SELECT COUNT(*) as fills FROM fills; SELECT outcome, COUNT(*) FROM outcomes GROUP BY outcome;"'
```

---

## Costs reality check

- e2-micro Always Free: **$0/bulan**
- Egress (data keluar): 1 GB free, bot konsumsi <100 MB/hari → safe
- Disk: 30 GB free, bot pakai <500 MB → safe

**Possible charges** (yang harus Anda hindari):
- Pakai machine type yang lebih gede (e2-small, dst): ke-charge
- Region selain US tertentu: kemungkinan ke-charge
- Static IP: ke-charge ($1.50/bulan kalau gak attached)

Set up billing alert di https://console.cloud.google.com/billing → Budgets → Create budget → alert kalau total > $1.

---

## Going live di GCP free tier

Setelah paper 24h hasil OK, untuk pivot ke live:
```bash
ssh mm-bot
cd ~/hyperliquid-mm-bot

# 1. Edit .env tambahkan WALLET_PRIVATE_KEY (transfer manual, jangan via clipboard cloud)
nano .env

# 2. Stop paper
pm2 stop paper

# 3. Dry-run live dulu (30 menit)
DRY_RUN=true pm2 start ecosystem.config.cjs --only live
pm2 logs live

# 4. Real live
pm2 stop live
pm2 start ecosystem.config.cjs --only live
pm2 save
```

---

## Latency dari GCP US ke Hyperliquid

GCP us-west1 → Hyperliquid (US-based) = **~20-50ms** (vs ~200ms dari Indonesia laptop).

Ini **8-10x lebih cepat dari laptop Anda** untuk eksekusi. Adverse rate seharusnya turun signifikan.

---

## Kalau "out of capacity" saat create e2-micro

GCP us-west1 kadang full. Coba:
- Zone lain: `us-west1-b`, `us-west1-c`
- Region lain free-eligible: `us-central1-a/b/c/f` atau `us-east1-b/c/d`

---

## Backup plan kalau GCP gak bisa

**Oracle Cloud Always Free** Singapore:
- Spec lebih gede: 4 ARM cores, 24GB RAM
- Latency ke Hyperliquid lebih tinggi dari GCP US, tapi masih bagus
- Signup lebih ribet, "out of capacity" sering muncul untuk ARM
- Lihat https://www.oracle.com/cloud/free/

Anda perlu adapt `deploy-gcp.sh` ke Ubuntu/Oracle Linux flavors.
