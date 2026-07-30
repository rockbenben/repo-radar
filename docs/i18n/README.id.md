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
- **Gali sebuah repo** — panel detail memberi rincian kesehatan lengkap, beralih / membuat / membuang branch, **commit di tempat** dengan diff langsung, PR & CI GitHub sesuai permintaan, commit terbaru, stash, heatmap 12 minggu, dan pembersihan sekali klik untuk branch yang sudah ter-merge — hanya ditawarkan selagi kamu berada di `main`/`master`, satu-satunya posisi di mana “sudah ter-merge” berarti ter-merge ke trunk. Membuang perubahan memulihkan berkas terlacak dan menghapus yang tak terlacak, tetapi tidak menyentuh isi submodul maupun repo git bersarang yang tak terlacak; kalau masih ada yang tertinggal, ia memberitahumu alih-alih melaporkan sukses.
- **Selalu terkini** — jalur penyegaran bawaan adalah pemindaian ulang tiap 30 menit ditambah pemindaian manual dari bilah atas. Pemindaian otomatis saat file berubah **nonaktif secara default** dan dinyalakan sendiri di panel pengaturan: ia lokal saja dan tidak pernah menyentuh jaringan, tetapi saat beberapa proyek dibangun sekaligus, buffer notifikasi kernel meluap terus-menerus, dan setiap luapan berharga satu pemindaian ulang — harga tetap yang terlalu mahal untuk alat yang dipakai sekadar melirik apa yang berubah. Kalau dinyalakan, di Windows dan macOS, satu pemantauan rekursif per direktori pemindaian mencakup seluruh repo di bawahnya, sehingga menambah, menghapus, atau mengganti nama repo terlihat dalam hitungan detik; di Linux repo dipantau satu per satu dan `watchLimit` (bawaan 200, 0 = tanpa batas) membatasi jumlahnya, dengan prioritas untuk repo favorit dan yang baru di-commit. Kalau luapan terus terjadi, pemindaian ulang penambal merenggang secara eksponensial (paling sering tiap 30 menit) dan tidak lagi membangun ulang pemantauan — itu hanya terjadi kalau target pemantauan benar-benar hilang. Pemindaian ulang tiap 30 menit menutup apa yang terlewat, bilah atas menampilkan “terakhir dipindai”, dan panel pengaturan menampilkan cakupan secara langsung (“memantau M dari N”). Mengganti nama atau memindahkan repo tetap mempertahankan tag, bintang, status arsip, dan catatannya — repo-radar melacak identitas, bukan sekadar path. Pencocokan terjadi pada putaran pemindaian **tepat setelah** perpindahan, sehingga tersisa dua celah: perpindahan lambat antar-volume yang membentang di dua putaran pemindaian, dengan penambahan/penghapusan repo lain atau pemindaian ulang berkala jatuh di antaranya; dan perpindahan yang tujuannya tidak dipindai pada putaran itu — memindahkan repo ke luar direktori pemindaian lalu baru menambahkan lokasi barunya sebagai direktori pemindaian adalah cara paling umum terkena. Keduanya jatuh kembali ke identitas berbasis path: repo muncul sebagai kartu baru, dan tag/bintang/arsip/catatannya tertinggal di bawah id yang tidak lagi dimilikinya. Fetch latar terjadwal bersifat opsional. Tab **Stats** (heatmap commit setahun, paling/paling tidak aktif) dan tab **Worklog** yang menyalin rentang tanggal sebagai laporan mingguan Markdown.
- **Mulai & pindahkan repo** — **+ New** menyarankan proyek bernomor berikutnya, menjalankan `git init`, menulis README, dan mengadopsinya ke papan; ekspor / impor manifest membawa setelan Anda antar-mesin.

UI-nya antd 6 dengan tema instrument-cockpit gelap, dilokalkan ke dalam 18 bahasa (otomatis dicocokkan dengan browser Anda pada kunjungan pertama, RTL untuk bahasa Arab).

## Berjalan diam-diam di latar belakang

Menutup jendela hanya menyembunyikan repo-radar ke tray, sehingga pemindaian ulang berkala, pemantauan berkas (kalau kamu menyalakannya), fetch terjadwal, dan alert GitHub tetap berjalan — klik ikon tray untuk memunculkan papannya kembali, atau benar-benar keluar lewat menu tray. (Di Linux, yang tray desktop-nya kerap tak bisa diandalkan, menutup jendela berarti langsung keluar; pakai Jalankan saat login agar ia tetap berjalan di latar.)

Saat keluar, repo-radar menunggu hingga 10 detik agar pekerjaan git yang sudah berjalan — pull massal, stash yang dibuang, fetch terjadwal — selesai, supaya tidak ada yang terpotong di tengah penulisan dan meninggalkan `.git/index.lock` yang usang. Kalau waktu itu tidak cukup, ia tetap keluar dan mencatatnya di log: itulah satu-satunya tempat yang menjelaskan `index.lock` yang kamu temukan kemudian.

Aktifkan **Jalankan saat login** di ⚙ Pengaturan dan ia mulai tanpa jendela bersama sesi Anda — tak ada jendela sampai Anda memintanya. Notifikasi desktop opsional hanya menyala saat ada yang *baru* masuk ke antrean Anda, bahkan dengan jendela tertutup. Pembaruan sengaja dibuat manual (tanpa auto-update): cukup jalankan installer baru menimpa yang lama. Log ditulis ke `<config dir>/logs/repo-radar.log`.

## Konfigurasi

Semua yang disentuh UI disimpan ke `~/.repo-radar/config.json` — Anda jarang perlu membukanya. Field yang penting:

| Bidang | Apa fungsinya |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | tempat memindai (menemukan `.git` hingga kedalaman 6, tidak mengikuti symlink), apa yang dilewati, dan repo yang ditambahkan di luar roots — entri `manualRepos` yang diganti nama atau dipindahkan tidak dilacak lewat identitas seperti repo hasil pemindaian; kartunya berstatus error sampai kamu memperbarui path-nya di sini, dan jika perpindahan sudah lewat lebih dari satu putaran pemindaian, pembaruan itu memulihkan kartunya tetapi tidak tag/bintang/arsip/catatannya |
| `health` | `{ staleDays, disabledRules }` — atur ambang "stale" atau nonaktifkan pemeriksaan tertentu |
| `open` | template perintah untuk tombol editor / terminal / folder (`{path}` = path repo) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | perilaku latar belakang — yang aktif secara default hanya `autoScanMinutes` (30); tiga sisanya, termasuk `autoWatch`, nonaktif. `watchLimit` (200, 0 = tanpa batas) **hanya berlaku di Linux**, tempat repo dipantau satu per satu; Windows dan macOS memakai satu pemantauan rekursif per direktori pemindaian dan selalu mencakup semua repo |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | pengaturan per-repo |

Ada dua berkas lain di samping `config.json`, keduanya aman dihapus — repo-radar akan membangunnya kembali, hanya dengan biaya yang berbeda. `repo-cache.json` mengingat field git “berat” setiap repo (stash, tag, remote, branch ter-merge…) yang dikunci pada sidik jari `.git`, sehingga repo yang tidak berubah melewati panggilan git itu pada pemindaian berikutnya; menghapusnya hanya membuat pemindaian berikutnya lebih lambat, sekali saja. `repo-identity.json` adalah buku besar identitas yang membuat repo yang diganti nama atau dipindahkan tetap menyimpan tag, bintang, status arsip, dan catatannya alih-alih dianggap repo yang benar-benar baru. Di sini kehilangannya langsung, bukan tertunda: repo mana pun yang sudah diganti nama atau dipindahkan **sebelum** berkas itu hilang akan mendapat id baru pada pemindaian berikutnya, dan tag/bintang/arsip/catatannya tertinggal di bawah id yang tidak lagi dimilikinya. Repo yang belum pernah diganti nama tidak terpengaruh, dan sejak buku besar itu terbangun kembali, penggantian nama kembali terlindungi.

`REPO_RADAR_CONFIG` dan `REPO_RADAR_PORT` (bawaan 17420) mengganti path config dan port — atur **keduanya** untuk menjalankan instance kedua yang sepenuhnya independen. Server hanya mengikat `127.0.0.1` dan memvalidasi header Origin pada setiap permintaan API dan WebSocket.

Port bawaan sengaja berada di atas rentang port dinamis OS: Windows memakai 49152–65535 secara bawaan, tetapi menjadi 1024–15000 begitu Hyper-V/WSL2 terpasang, dan sistem mencadangkan blok utuh dari rentang yang sedang aktif — port di dalamnya gagal di-bind dengan `EACCES`, dan blok-blok itu bergeser setiap kali reboot.

Jika port **bawaan** tetap tidak bisa di-bind, repo-radar beralih ke kandidat berikutnya (`+1000`, `+2000`, `+3000`, lalu port yang ditentukan OS) alih-alih menolak berjalan, mengingat port yang akhirnya dipakai dan memakainya lagi pada peluncuran berikutnya, serta menampilkannya di samping versi pada ⚙ Pengaturan. Mengingatnya penting karena port adalah bagian dari origin halaman, dan papan menyimpan tampilan tersimpan, log aktivitas, tema, dan bahasa di penyimpanan browser yang terikat origin — membiarkan port berpindah-pindah membuat data itu seolah hilang lalu muncul lagi. Hapus `<direktori config>/port-state.json` untuk kembali ke port bawaan.

Port yang Anda tetapkan sendiri lewat `REPO_RADAR_PORT` tidak pernah diganti — itu janji kepada bookmark, upstream reverse proxy, dan skrip Anda, jadi port yang tidak bisa di-bind akan gagal dengan jelas. Sama halnya pada `npm run dev`, karena target proxy vite sudah ditetapkan saat konfigurasi dimuat.

## Pengembangan

```bash
npm run dev     # vite + jendela aplikasi dengan hot reload
npm test        # test suite server + web + desktop serta typecheck
npm run dist    # build installer ke dist-electron/
```

Stack: shell Electron + Node + Hono (semua git lewat `spawn`, tanpa dependensi native) + Vite / React 19 / antd 6, dengan chokidar + WebSocket untuk pembaruan langsung. Server Hono berjalan di dalam proses main Electron dan jendelanya memuatnya lewat `127.0.0.1`, jadi UI-nya murni HTTP + WebSocket — persis seperti kalau dijalankan di browser.

## Tentang 365 Open Source Plan

Proyek **#027** dari [365 Open Source Plan](https://github.com/rockbenben/365opensource) — satu orang + AI, 300+ proyek open-source dalam setahun. [Ajukan ide Anda →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)