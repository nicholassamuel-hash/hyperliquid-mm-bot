# Deploy ke Nevacloud — Rp 42.000/bulan

## Yang Anda dapat
- VPS Cloud KVM 1 vCPU + 1 GB RAM + NVMe SSD
- **Datacenter Jakarta**
- IP Public IPv4 dedicated
- Bandwidth unmetered (fair use)
- **Pay langsung Rupiah** via BCA/Mandiri/BNI/BRI/GoPay/QRIS

## Yang Anda butuhkan
- Email + nomor HP Indonesia
- KTP (kadang diminta untuk verifikasi KYC)
- Saldo Rupiah ~Rp 50K (untuk bulan pertama, optional setup Auto Renew)

---

## Step 1 — Sign up Nevacloud (5 menit)

1. Buka https://nevacloud.com
2. Klik **"Daftar"** atau **"Register"** di pojok kanan atas
3. Isi:
   - Email
   - Nama lengkap
   - Password
   - Nomor HP
4. Verify email (cek inbox)
5. Login ke dashboard

---

## Step 2 — Pilih & order VPS (3 menit)

1. Di dashboard, klik menu **"Cloud VPS"** atau **"Order Now"**
2. Pilih paket termurah — sekitar **Rp 42.000/bulan**:
   - 1 vCPU
   - 1 GB RAM
   - NVMe SSD ~20 GB
3. Pilih konfigurasi:
   - **OS**: **Ubuntu 24.04 LTS** (atau 22.04 LTS kalau 24 belum ada)
   - **Datacenter**: Jakarta (default)
   - **Billing cycle**: Monthly
   - **Hostname**: `mm-bot` (atau bebas)
4. Klik **"Add to Cart"** → **"Checkout"**

## Step 3 — Bayar (2 menit)

1. Pilih metode pembayaran (rekomendasi: **BCA Virtual Account** atau **QRIS** untuk speed)
2. Lakukan transfer / scan QRIS
3. Tunggu konfirmasi pembayaran (BCA biasanya 1-5 menit, QRIS instant)

## Step 4 — Setup SSH key (di laptop, 2 menit)

Sebelum VPS siap, buat SSH key dulu di PowerShell laptop:

```powershell
# Generate SSH key
ssh-keygen -t ed25519 -C "neva-bot" -f $env:USERPROFILE\.ssh\neva-bot
# Tekan Enter 2x untuk no-password (atau set passphrase kalau mau extra security)

# Tampilin public key — copy SELURUH baris
type $env:USERPROFILE\.ssh\neva-bot.pub
```

Output mulai dengan `ssh-ed25519 AAAAC3... neva-bot` — copy untuk paste nanti.

---

## Step 5 — Akses VPS (5 menit setelah pembayaran terkonfirmasi)

Setelah Nevacloud activate VPS (notif via email):

1. Login dashboard Nevacloud
2. Buka detail VPS — Anda akan lihat:
   - **Public IP** (e.g. 103.150.x.x)
   - **Root password** (atau setup via dashboard kalau pakai SSH key)
3. **Opsi A — pakai password** (cepat tapi kurang aman):
   ```powershell
   ssh root@<IP-VPS>
   # Paste password saat diminta
   ```
4. **Opsi B — pakai SSH key** (lebih aman, recommended):
   - Di dashboard Nevacloud, cari menu "SSH Keys" atau "Security"
   - Add SSH key — paste public key yang tadi di-copy
   - Atau via cara manual:
   ```powershell
   # First-time login pakai password
   ssh root@<IP-VPS>
   # Setelah masuk, di terminal VPS:
   mkdir -p ~/.ssh && nano ~/.ssh/authorized_keys
   # Paste public key, simpan (Ctrl+O, Enter, Ctrl+X)
   chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh
   exit
   
   # Sekarang login tanpa password
   ssh -i $env:USERPROFILE\.ssh\neva-bot root@<IP-VPS>
   ```

---

## Step 6 — Deploy bot (5 menit)

Di terminal VPS:

```bash
# Create non-root user (security best practice)
adduser bot
usermod -aG sudo bot
# Set password sederhana atau enter untuk default
# Pindah ke user bot
su - bot

# Clone & deploy
git clone https://github.com/nicholassamuel-hash/hyperliquid-mm-bot.git bot && cd bot && bash scripts/deploy-gcp.sh
```

Script akan otomatis:
1. Install Node.js 22 + git + PM2
2. Clone bot ke `~/bot`
3. Install deps + build
4. Start paper trader di PM2
5. Setup boot persistence

Tekan **Enter** sekali saat script mau pakai .env default.

---

## Step 7 — Verify bot jalan

```bash
pm2 status
pm2 logs paper --lines 30
```

Anda harus lihat:
- `pm2 status` → `paper online`
- `pm2 logs paper` → `WS connected, subscribing`, `Market context refreshed`

---

## Step 8 — Lupakan, log out

```bash
exit  # keluar dari user bot
exit  # keluar dari SSH
```

Bot tetap jalan di VPS 24/7. PM2 auto-restart kalau crash, systemd boot persistence sudah aktif.

Besok pagi:
```powershell
ssh -i $env:USERPROFILE\.ssh\neva-bot bot@<IP-VPS>
cd ~/bot && npm run dashboard
```

---

## Cost & billing reality

- **Rp 42.000/bulan** untuk paket entry
- Setup auto-renew lewat dashboard supaya bot gak mati saat habis bulan
- Total setahun: ~Rp 504.000 (~$32)
- Bandingkan dengan modal trading $30: cost VPS sama dengan trading capital — ini real consideration

---

## Latency dari Nevacloud Jakarta ke Hyperliquid

- Nevacloud Jakarta → Hyperliquid (US East) = **~250-300ms**
- Sama dengan laptop Anda dari Indonesia
- **Tidak ada upside latency** dari pindah ke Jakarta VPS
- Upside-nya: **uptime 24/7** (laptop sleep/restart = bot mati)

Kalau performa bot ternyata jelek karena latency, opsi adalah migrasi ke VPS US/EU yang lebih murah seperti RackNerd US $0.94/bulan effective.

---

## Going live di Nevacloud

Sama dengan flow umum. SSH ke VPS, edit `.env`, ganti `pm2 start ecosystem.config.cjs --only live`.

⚠️ **PENTING soal private key**: kalau Anda upload `.env` dengan `WALLET_PRIVATE_KEY` ke Nevacloud VPS, itu artinya:
- Nevacloud staff secara teknis bisa baca file Anda
- Risk lebih rendah dari Chinese cloud, tapi tetap ada
- Untuk modal kecil ($30), risk acceptable
- Untuk modal besar, pertimbangkan custodial setup atau dedicated server fisik

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pembayaran sudah, VPS belum aktif | Konfirmasi pembayaran lag | Cek status di dashboard, contact support via WA/chat |
| `Permission denied (publickey)` | SSH key gak ke-paste / typo | Re-paste public key di dashboard atau setup ulang |
| `Connection timed out` saat SSH | Firewall block port 22 | Cek di dashboard "Firewall" atau "Networking", allow port 22 |
| Bot keduga "killed" sering | RAM 1 GB hampir habis | Lihat `free -m`, kemungkinan upgrade ke paket 2 GB (~Rp 65K) |
| WS error timeout ke Hyperliquid | Outbound 443 di-throttle | Cek `ping api.hyperliquid.xyz` & `curl https://api.hyperliquid.xyz/info` |

---

## Support Nevacloud

- WhatsApp: cek nevacloud.com untuk nomor support
- Live chat: di dashboard
- Email: support@nevacloud.com
- Response time: biasanya 1-4 jam jam kerja

Bahasa Indonesia available di semua channel — paling user-friendly dari semua opsi.
