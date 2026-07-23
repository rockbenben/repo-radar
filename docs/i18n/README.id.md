<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — dasbor lokal yang mengawasi semua Git repo Anda dan menandai yang butuh perhatian Anda" />
</p>

# repo-radar

> Rencana 365 Open Source #027 · Dasbor lokal yang mengawasi semua Git repo Anda dan menunjukkan mana yang butuh perhatian Anda.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · **Bahasa Indonesia**

Anda punya Git repo lebih banyak daripada yang sanggup Anda pantau satu per satu. repo-radar mengawasi semuanya dan menyodorkan beberapa yang benar-benar butuh perhatian Anda sekarang — supaya sisanya tak perlu lagi memenuhi pikiran Anda.

Ia memunculkan hal-hal yang biasanya justru lupa Anda periksa:

- **Repo yang sudah lepas dari ingatan** — semua repo milik Anda dalam satu layar, bisa dicari, buka yang mana pun cukup dengan sekali klik.
- **Pekerjaan yang belum tuntas** — perubahan yang belum di-commit, belum di-push, atau masih ter-stash, ditandai sebelum sempat hilang.
- **GitHub menunggu Anda** — PR terbuka, issue, dan CI yang gagal di seluruh repo, dikumpulkan lewat `gh` lokal Anda yang sudah terautentikasi.
- **Proyek yang mulai basi** — yang sudah terlalu lama tak tersentuh, atau telat dirilis.

Yang butuh tindakan akan naik ke bagian atas papan sebagai antrean, diurutkan menurut tingkat urgensi, satu item per repo — klik untuk langsung menanganinya. Singkirkan dengan ✓ dan ia takkan muncul lagi sampai benar-benar ada yang berubah; saat tak ada yang menunggu, akan tertulis "all clear." Sisa repo Anda selalu bisa ditemukan cukup dengan sekali cari.

## Instal

Ambil file untuk platform Anda dari [Releases](https://github.com/rockbenben/repo-radar/releases) — tanpa perlu Node.js. Aplikasi ini belum ditandatangani secara digital (code-sign), jadi setiap OS akan memberi peringatan saat pertama kali dijalankan:

- **Windows** — jalankan `repo-radar-<version>-x64-setup.exe`; pada prompt SmartScreen klik *More info → Run anyway*.
- **macOS** — buka `repo-radar-<version>-arm64.dmg` lalu seret aplikasinya ke Applications. Klik kanan → Open saat pertama kali; kalau macOS menyebutnya rusak, bersihkan flag quarantine sekali dengan `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Atau jalankan dari source:

```bash
npm install
npm start
```

Saat pertama kali dijalankan, klik **Tambah direktori pemindaian** (atau ⚙ Pengaturan → Direktori pemindaian) lalu arahkan ke folder tempat repo Anda berada — tak perlu menyentuh JSON, tak perlu restart; begitu Anda simpan, ia langsung memindai ulang. Pengaturan tersimpan di `~/.repo-radar/config.json` kalau Anda lebih suka menyuntingnya sendiri.

## Papan

Satu kartu per repo — warna kesehatan, branch, rincian working-tree, ahead/behind, commit terakhir, tag — dengan **editor / terminal / folder** sekali klik di setiap kartu. Dari sini Anda:

- **Temukan** — cari, klik bahasa / `#tag` / lampu perhatian untuk memfilter, urutkan, dan kelompokkan berdasarkan folder atau bahasa; simpan filter + urutan + pengelompokan mana pun sebagai view bernama. ⌘/Ctrl-K membuka launcher.
- **Bertindak secara batch** — pilih repo untuk fetch / pull (`--ff-only`) / push, atau jalankan perintah shell secara paralel di seluruhnya (dengan pratinjau dry-run dan output per-repo). Satu repo yang gagal tak akan pernah menghentikan yang lainnya.
- **Gali sebuah repo** — panel detail memberi rincian kesehatan lengkap, beralih / membuat / membuang branch, **commit di tempat** dengan diff langsung, PR & CI GitHub sesuai permintaan, commit terbaru, stash, heatmap 12 minggu, dan pembersihan sekali klik yang aman untuk branch yang sudah ter-merge.
- **Selalu terkini** — pemindaian otomatis saat file berubah dan fetch latar terjadwal yang opsional, keduanya nonaktif secara default. Tab **Stats** (heatmap commit setahun, paling/paling tidak aktif) dan tab **Worklog** yang menyalin rentang tanggal sebagai laporan mingguan Markdown.
- **Mulai & pindahkan repo** — **+ New** menyarankan proyek bernomor berikutnya, menjalankan `git init`, menulis README, dan mengadopsinya ke papan; ekspor / impor manifest membawa setelan Anda antar-mesin.

UI-nya antd 6 dengan tema instrument-cockpit gelap, dilokalkan ke dalam 18 bahasa (otomatis dicocokkan dengan browser Anda pada kunjungan pertama, RTL untuk bahasa Arab).

## Berjalan diam-diam di latar belakang

Menutup jendela hanya menyembunyikan repo-radar ke tray, sehingga pemantauan berkas, fetch terjadwal, dan alert GitHub tetap berjalan — klik ikon tray untuk memunculkan papannya kembali, atau benar-benar keluar lewat menu tray. (Di Linux, yang tray desktop-nya kerap tak bisa diandalkan, menutup jendela berarti langsung keluar; pakai Jalankan saat login agar ia tetap berjalan di latar.)

Aktifkan **Jalankan saat login** di ⚙ Pengaturan dan ia mulai tanpa jendela bersama sesi Anda — tak ada jendela sampai Anda memintanya. Notifikasi desktop opsional hanya menyala saat ada yang *baru* masuk ke antrean Anda, bahkan dengan jendela tertutup. Pembaruan sengaja dibuat manual (tanpa auto-update): cukup jalankan installer baru menimpa yang lama. Log ditulis ke `<config dir>/logs/repo-radar.log`.

## Konfigurasi

Semua yang disentuh UI disimpan ke `~/.repo-radar/config.json` — Anda jarang perlu membukanya. Field yang penting:

| Bidang | Apa fungsinya |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | tempat memindai (menemukan `.git` hingga kedalaman 6), apa yang dilewati, dan repo yang ditambahkan di luar roots |
| `health` | `{ staleDays, disabledRules }` — atur ambang "stale" atau nonaktifkan pemeriksaan tertentu |
| `open` | template perintah untuk tombol editor / terminal / folder (`{path}` = path repo) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | perilaku latar belakang — semuanya nonaktif secara default |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | pengaturan per-repo |

`REPO_RADAR_CONFIG` dan `REPO_RADAR_PORT` (bawaan 7420) mengganti path config dan port — atur **keduanya** untuk menjalankan instance kedua yang sepenuhnya independen. Server hanya mengikat `127.0.0.1` dan memvalidasi header Origin pada setiap permintaan API dan WebSocket.

## Pengembangan

```bash
npm run dev     # vite + jendela aplikasi dengan hot reload
npm test        # test suite server + web + desktop serta typecheck
npm run dist    # build installer ke dist-electron/
```

Stack: shell Electron + Node + Hono (semua git lewat `spawn`, tanpa dependensi native) + Vite / React 19 / antd 6, dengan chokidar + WebSocket untuk pembaruan langsung. Server Hono berjalan di dalam proses main Electron dan jendelanya memuatnya lewat `127.0.0.1`, jadi UI-nya murni HTTP + WebSocket — persis seperti kalau dijalankan di browser.

## Tentang 365 Open Source Plan

Proyek **#027** dari [365 Open Source Plan](https://github.com/rockbenben/365opensource) — satu orang + AI, 300+ proyek open-source dalam setahun. [Ajukan ide Anda →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)