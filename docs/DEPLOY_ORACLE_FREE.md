# Deploy ke Oracle Cloud Always Free — Singapore ARM

## Yang akan Anda dapat
- **VM ARM Ampere A1.Flex**: 4 OCPU + 24 GB RAM (vs GCP free 1 vCPU/1GB — 24x lebih besar)
- **Region**: Singapore (ap-singapore-1)
- **Storage**: 200 GB boot volume free
- **Network**: 10 TB egress/bulan free
- **Cost**: $0 selamanya asal stay di Always Free limits

## Yang Anda butuhkan
- Email (Gmail OK)
- Credit/debit card untuk verifikasi (TIDAK akan kena charge selama di free tier)
- Nomor HP (untuk OTP verifikasi)
- Sabar — signup bisa 30 menit sampai 2 hari kalau region full

---

## ⚠️ Heads-up sebelum mulai

1. **"Out of host capacity" error** sering muncul untuk ARM Ampere — region Singapore biasanya tersedia tapi kadang penuh. Kalau full, retry beberapa jam kemudian atau coba zone lain.

2. **Region selection PERMANEN** — pilih home region sekali, gak bisa ganti. Singapore = pilih `Singapore (ap-singapore-1)` saat signup.

3. **Pastikan stay di "Always Free"** — Oracle kasih juga 30-day trial dengan $300 credit. Jangan tergoda pakai resource non-free, nanti habis credit bisa kena charge.

---

## Step 1 — Sign up Oracle Cloud (10-30 menit)

1. Buka https://www.oracle.com/cloud/free/
2. Klik **"Start for free"**
3. Isi:
   - Email
   - Country: **Indonesia**
   - Account type: **Individual**
   - First/last name
4. Verifikasi email (cek inbox, klik link)
5. Lanjut form:
   - Address Indonesia Anda
   - Nomor HP (akan kirim SMS OTP)
6. **Region selection**: pilih **Singapore (ap-singapore-1)** ⚠️ permanen!
7. Masukkan CC/debit card — verifikasi
8. Submit. Tunggu account approval ($1-5 temporary hold di CC akan refund).

Kalau approval butuh waktu, kadang sampai 24 jam. Tunggu email "Your Oracle Cloud account is ready".

---

## Step 2 — Setup networking (5 menit)

Oracle gak otomatis kasih SSH access. Anda perlu setup VCN (Virtual Cloud Network) dulu — biasanya wizard otomatis bikin saat create instance, tapi sometimes manual.

1. Login ke https://cloud.oracle.com
2. Klik menu hamburger ☰ kiri-atas → **Networking** → **Virtual Cloud Networks**
3. Kalau belum ada VCN, klik **"Start VCN Wizard"**:
   - Pilih **"Create VCN with Internet Connectivity"** → Next
   - VCN Name: `bot-vcn`
   - Compartment: keep default
   - Use default CIDR blocks
   - Klik **Next** → **Create**
4. Sekarang ada VCN dengan public subnet.

---

## Step 3 — Generate SSH key (Windows, 2 menit)

Di laptop Anda, buka **PowerShell**:

```powershell
# Generate SSH key kalau belum ada
ssh-keygen -t ed25519 -C "oracle-bot" -f $env:USERPROFILE\.ssh\oracle-bot
# Enter password (atau enter kosong untuk no-password)

# Tampilin public key — copy semua isinya untuk paste nanti
type $env:USERPROFILE\.ssh\oracle-bot.pub
```

Output mulai dengan `ssh-ed25519 AAAAC3... oracle-bot` — **copy SELURUH baris** ini.

---

## Step 4 — Create ARM Ampere instance (5-15 menit, bisa retry)

1. Di Oracle Cloud console, menu ☰ → **Compute** → **Instances**
2. Klik **"Create instance"**
3. Isi:
   - **Name**: `mm-bot`
   - **Compartment**: default
   - **Placement**: 
     - Availability domain: pilih yang ada
   - **Image and shape**:
     - Klik "Change image" → pilih **Ubuntu** → version **24.04** (Minimal kalau ada)
     - Klik "Change shape" → pilih **"Ampere"** → shape **VM.Standard.A1.Flex**
     - Slider: **OCPU = 1** + **Memory = 6 GB** (cukup untuk bot, hemat capacity)
   - **Networking**:
     - Primary network: pilih VCN `bot-vcn` yang tadi dibikin
     - Subnet: public subnet
     - Public IPv4: **Assign a public IPv4 address** ✓
   - **Add SSH keys**:
     - **Paste public keys** → paste isi `.pub` yang tadi di-copy
   - **Boot volume**: 
     - Default 47 GB free, bisa naikkan sampai 200 GB free
4. Klik **"Create"**

Kalau muncul error **"Out of host capacity"**:
- Tunggu 30 menit, retry
- Atau coba availability domain lain (ada AD-1, AD-2, AD-3 di Singapore)
- Atau turunkan OCPU ke 1 dan Memory ke 6 GB (kapasitas kecil lebih sering tersedia)
- Worst case: retry besok

Setelah sukses, tunggu ~1 menit sampai status "Running". Catat **Public IPv4 address** — misal `158.180.123.45`.

---

## Step 5 — SSH ke VM (2 menit)

Di PowerShell laptop:

```powershell
# Ganti 158.180.123.45 dengan IP VM Anda
ssh -i $env:USERPROFILE\.ssh\oracle-bot ubuntu@158.180.123.45
```

First time akan tanya "Are you sure you want to continue" → ketik `yes` Enter.

Anda harusnya masuk sebagai user `ubuntu` di terminal Linux.

---

## Step 6 — Open firewall untuk Hyperliquid (penting!)

Oracle by default block semua egress kecuali web. Bot kita perlu konek ke `wss://api.hyperliquid.xyz` (port 443) — biasanya udah allowed, tapi kalau gak jalan:

Di terminal VM:
```bash
sudo iptables -L
# Kalau ada rule REJECT, atau bot logs error "ECONNREFUSED", jalanin:
sudo iptables -I INPUT -p tcp --dport 22 -j ACCEPT
sudo iptables -I OUTPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

(Bot cuma butuh outbound 443 untuk WS + HTTPS, jadi biasanya default OK.)

---

## Step 7 — Deploy bot (5 menit)

Di terminal VM:

```bash
git clone https://github.com/nicholassamuel-hash/hyperliquid-mm-bot.git bot && cd bot && bash scripts/deploy-gcp.sh
```

Script jalan ~3-5 menit. Anda akan dipromot untuk Enter saat default .env mau dipakai — tekan Enter.

Verify:
```bash
pm2 status
pm2 logs paper --lines 30
```

Anda harus lihat `WS connected, subscribing`, `Market context refreshed`, dst.

---

## Step 8 — Lupakan, log out

```bash
exit
```

Bot tetap jalan di VM forever (PM2 auto-restart kalau crash, systemd boot persistence sudah aktif).

Besok pagi kembali:
```powershell
ssh -i $env:USERPROFILE\.ssh\oracle-bot ubuntu@<IP-Anda>
cd ~/bot && npm run dashboard
```

---

## Cost reality check Oracle Free

| Resource | Free quota | Bot consumption | Safe? |
|---|---|---|---|
| OCPU (ARM) | 4 per akun | 1 OCPU | ✅ |
| Memory | 24 GB | ~300 MB | ✅ |
| Boot disk | 200 GB | ~5 GB | ✅ |
| Egress | 10 TB/bulan | <1 GB/hari = 30 GB | ✅ |
| Reserved IPv4 | 2 free | 1 | ✅ |

**Setup billing alert**:
1. Console → Billing → Cost Analysis → set alert kalau >$1
2. Atau enable "Always Free protection" di account preferences

---

## Going live di Oracle

Sama dengan flow GCP. SSH, edit .env, `pm2 stop paper && pm2 start ecosystem.config.cjs --only live`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` saat SSH | SSH key salah path / typo | Re-check `-i` path & username `ubuntu` |
| `Out of host capacity` saat create | Region penuh | Retry, atau OCPU=1 GB=6 |
| Bot timeout WS | Firewall block 443 | `sudo iptables -L` check, allow outbound 443 |
| Account verification stuck > 24h | Oracle backlog | Submit support ticket via console |
| Account suspended | Resource exceeded | Read email Oracle, biasanya soal credit |

---

## Kalau "out of host capacity" terus

Backup options:
1. **Coba ARM A1 dengan spec lebih kecil** (1 OCPU, 6 GB RAM) — kapasitas kecil sering tersedia
2. **Coba region lain Always Free-eligible**: Frankfurt, Phoenix, Ashburn
3. **Coba x86 micro instance Always Free** — VM.Standard.E2.1.Micro (1 OCPU, 1 GB RAM) — biasanya lebih tersedia
4. **Pakai script auto-retry** — ada banyak di GitHub yang ngeloop sampai capacity tersedia

Honest: kalau Oracle Singapore stuck > 2 hari, pivot ke **GCP US** (15 min setup) untuk gak buang waktu. Codebase sama, deploy script sama-sama work.
