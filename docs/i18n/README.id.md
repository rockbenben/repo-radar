<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Rencana 365 Open Source #027 · Dasbor Git repo lokal — sebuah antrean aksi lintas-repo yang menjawab apa yang butuh perhatian Anda sekarang.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · **Bahasa Indonesia**

Dasbor Git repo lokal yang memindai setiap repo di komputer Anda dan menampilkan satu layar utama di hadapan Anda terlebih dahulu: sebuah **antrean aksi** lintas-repo yang menjawab *apa yang butuh perhatian Anda sekarang* — klik satu item dan langsung tindak lanjuti. UI dibangun di atas antd 6 dengan tema instrument-cockpit yang mendalam.

## Mulai cepat

```bash
npm install
npm run build   # build frontend
npm start       # http://localhost:7420
```

Saat pertama kali dijalankan, sebuah konfigurasi default dibuat di `~/.repo-radar/config.json`. Ubah `roots` untuk menambahkan direktori yang ingin dipindai (mis. `D:\Projects` — escape backslash menjadi `D:\\Projects` dalam JSON), lalu klik **Rescan** di panel.

## Needs you (layar masuk)

Antrean **Needs you** di bagian atas papan adalah antrean aksi lintas-repo: diurutkan berdasarkan urgensi, satu item per repo — satu hal paling mendesak, bukan sekadar dasbor "berapa banyak commit" yang cuma pajangan.

- **Waiting on you**: PR terbuka dari orang lain, issue terbuka dari orang lain, CI merah pada branch default (diagregasi di latar belakang lewat `gh` lokal yang sudah terautentikasi, disegarkan setiap 12 menit, atau ↻ secara manual; PR/issue terbuka milik Anda sendiri dihitung sebagai WIP dan dikecualikan) — klik satu item untuk langsung menuju halaman GitHub yang sesuai
- **At risk of being lost**: konflik / tertinggal / belum di-commit / belum di-push, makin lama dibiarkan makin tinggi peringkatnya — pekerjaan yang belum di-push mendapat tombol push sekali klik, sisanya membuka panel detail
- **Overdue for release**: repo dengan kebiasaan memberi tag yang sudah menumpuk ≥3 commit sejak tag terakhir tanpa rilis — sebuah dorongan untuk merilis (repo yang tidak pernah memberi tag dibiarkan; tag terakhir dipilih berdasarkan waktu pembuatan di seluruh repo, terlepas dari branch yang sedang aktif)
- **Forgotten stash**: stash yang tidak tersentuh selama ≥7 hari — klik untuk langsung menuju kotak masuk stash
- **Dismiss**: ketuk ✓ untuk membersihkan item hingga ada hal baru terjadi — item berbasis hitungan perlu jumlahnya bertambah, item berbasis perubahan perlu commit baru lagi; dismiss stash adalah snooze yang akan muncul kembali setelah 30 hari sehingga stash yang benar-benar terlupakan tidak akan pernah dibungkam selamanya
- Perluas melebihi 10 item untuk melihat semuanya; menampilkan "all clear" saat tidak ada yang tersisa. Menciut menjadi banner tipis di bagian atas

## Board

- **Kartu**: satu kartu per repo (hingga 4 per baris, tinggi sama rata). Warna tepi kiri = kesehatan (hijau = tenang / kuning = perlu perhatian / merah = waspada). Menampilkan nama asli · deskripsi · bahasa · branch (ditandai jika bukan main) · rincian working-tree (`+staged ~modified`) · ahead/behind · tag kesehatan · commit terakhir · tautan remote · tag. Footer selalu menyediakan **editor / terminal / folder** sekali klik
- **Baris favorit**: baris "★ favorites" khusus di bagian atas papan — klik untuk membuka di editor Anda
- **Kluster pembacaan**: gauge FLEET / CRIT / WARN / CLEAN di bilah atas; jumlah alert menyala saat > 0
- **Klik untuk memfilter**: klik bahasa atau `#tag` pada kartu untuk langsung memasukkannya ke kotak pencarian
- **Urutkan**: terakhir dibuka / paling baru aktif (berdasarkan waktu commit) / berdasarkan nama — favorit selalu mengapung ke atas
- **Lampu perhatian**: chip di bilah atas yang merangkum jenis masalah (tanpa remote / detached HEAD / belum di-push / belum di-commit / tertinggal / stash); klik untuk memfilter. "Unpushed" dan "behind" masing-masing memiliki "push/pull all" sekali klik
- **Pengelompokan**: berdasarkan folder / berdasarkan bahasa / tanpa pengelompokan (datar)
- **Command palette ⌘/Ctrl-K**: sebuah launcher — ketik nama, tekan enter untuk membuka di editor Anda (tombol inline untuk terminal / folder / salin path / buka remote)
- **Filter tag**: pilih beberapa tag sekaligus di bilah atas (AND — harus membawa setiap tag yang dipilih); klik `#tag` pada kartu untuk menambahkannya. Filter + urutan + pengelompokan tersimpan bersama sebagai "view" bernama
- **Pratinjau inline**: "⋯" pada kartu memunculkan commit terbaru tanpa membuka panel detail
- **Auto-scan (nonaktif secara default)**: sakelar "manual ⟳ / auto ⟳" di bilah atas. Saat aktif, file watcher menyegarkan kartu yang terpengaruh secara otomatis (cooldown 60 detik; perubahan selama cooldown digabung, tidak pernah hilang). Saat nonaktif, state hanya diperbarui saat Rescan. Papan tetap terisi lewat satu pemindaian saat pertama kali dijalankan
- **Scheduled fetch (nonaktif secara default)**: "fetch: off / every 5–60 min" di bilah atas — secara berkala melakukan fetch setiap remote di latar belakang untuk menjaga ahead/behind tetap segar
- **18 bahasa**: ganti bahasa UI dari ⚙ Settings (Tionghoa Sederhana/Tradisional, Inggris, Jepang, Korea, Spanyol, Prancis, Jerman, Portugis, Rusia, Italia, Arab, Hindi, Bengali, Thai, Turki, Vietnam, Indonesia). Pada kunjungan pertama tanpa preferensi tersimpan, UI otomatis menyesuaikan dengan bahasa browser Anda (kembali ke bahasa Inggris jika tidak ada yang cocok); bahasa Arab otomatis beralih ke RTL. Waktu relatif dilokalkan secara native lewat `Intl`. Nama repo, deskripsi, dan pesan commit selalu dibiarkan tidak diterjemahkan

## Actions

- Footer kartu selalu menampilkan tombol editor / terminal / folder / salin path; membuka salah satunya mencatat stempel waktu "terakhir dibuka" yang digunakan untuk pengurutan
- Fetch / pull (`--ff-only`) / push dijalankan secara batch: pilih beberapa kartu → aksi batch dari bilah atas, atau klik sekali pada seluruh lampu perhatian "unpushed" / "behind". Progres ditampilkan secara langsung; satu repo yang gagal tidak menghentikan yang lain
- **Jalankan perintah lintas repo**: pilih kartu, ketik perintah di toolbar (mis. `npm install`), perintah dijalankan secara paralel di dalam direktori setiap repo yang dipilih. "Dry run" menampilkan pratinjau repo mana saja yang akan terpengaruh terlebih dahulu; "view output" menampilkan hasil per-repo setelahnya
- **Stash inbox**: jika ada stash yang tersisa, tautan "stash inbox (N)" muncul di bilah atas — mendaftar setiap perubahan yang di-stash di seluruh repo, dengan diff per-item, `apply` / `pop` / `drop`
- Memilih beberapa kartu juga memungkinkan Anda menerapkan tag secara massal
- **Ekspor/impor manifest**: ekspor manifest repo lengkap (path + remote + grup + tag) dari **+ new** untuk backup/pindah komputer; impor akan mengadopsi kembali repo yang sudah ada secara lokal dan mendaftar yang belum ada untuk di-clone
- Perintah open dapat dikonfigurasi per target di bawah `open` dalam config.json; `{path}` digantikan dengan path repo
- **+ New**: menyarankan nomor urut berikutnya (mis. `028-`) dan direktori induk dari proyek bernomor Anda yang sudah ada, lalu membuat foldernya, menjalankan `git init`, menulis README, dan memindainya kembali ke papan

## Health checks & stats

- Aturan (conflicted / no remote / detached HEAD / uncommitted / unpushed / untracked / behind / stash / stale) dapat dinonaktifkan satu per satu lewat `health.disabledRules`; `staleDays` menetapkan ambang batas "stale"
- **Mergeable branches**: kartu menandai berapa banyak branch lokal yang sudah ter-merge ke HEAD (tidak termasuk branch saat ini dan main/master); panel detail menyediakan pembersihan `git branch -d` sekali klik (hanya pernah menghapus branch yang sudah ter-merge — aman)
- **GitHub (opsional, lewat `gh` lokal yang sudah terautentikasi)**: antrean "needs you" mengagregasi PR terbuka / issue / CI branch default untuk setiap remote `github.com` di latar belakang (polling dengan rate-limit, disimpan ke disk, langsung tersedia saat restart). Panel detail juga dapat meminta detail PR terbuka dan run CI terbaru sesuai permintaan; deskripsi repo diisi ulang dari GitHub bila tersedia
- Tab **Stats**: heatmap commit lintas-repo selama setahun (hanya branch lokal), yang paling baru aktif, dan 10 repo yang paling lama tidak tersentuh
- Tab **Worklog**: pilih rentang tanggal untuk melihat linimasa commit lintas-repo (dapat difilter berdasarkan penulis — default ke "hanya saya" dengan mendeteksi otomatis identitas git Anda), dengan salin sekali klik sebagai laporan mingguan Markdown
- Klik kartu untuk membuka panel detail: rincian kesehatan lengkap, mergeable branches, **beralih / membuat / membuang branch lokal**, **commit di tempat** (ketik pesan, langsung commit) dengan diff perubahan yang tertunda secara langsung, PR/CI GitHub, mini heatmap 12 minggu, commit terbaru, stash, dan remote

## Mengatur repo

- Beri bintang ★ pada kartu untuk menjadikannya favorit (mengapung ke atas); tambah/hapus tag di panel detail (autocomplete dari tag yang pernah Anda gunakan) dan ubah grupnya ("auto" mengembalikan pengelompokan hasil turunan folder)
- **Notes / to-do**: catat "apa selanjutnya" di panel detail — ditampilkan pada kartu
- **Exclude**: sembunyikan repo yang tidak ingin Anda lihat; repo yang dikecualikan disembunyikan dari papan, alert, dan command palette secara default. "Excluded (N)" di bilah atas memungkinkan Anda melihat/mengelolanya secara terpisah (batalkan pengecualian dari panel detail)
- Perubahan diterapkan secara instan dan ditulis ke config.json tanpa memicu Git rescan

## Development

```bash
npm run dev     # menjalankan server(7420) + vite(5173) bersamaan, frontend mem-proxy /api
npm test        # test suite server + web lengkap serta kedua typecheck
```

Stack: Node + Hono (semua akses git lewat `spawn`, tanpa dependensi native), Vite + React 19 + antd 6 (dikustomisasi secara mendalam lewat variabel CSS), chokidar + WebSocket untuk pembaruan langsung.

## Konfigurasi (config.json)

| Field | Deskripsi |
| --- | --- |
| `roots` | Direktori akar yang dipindai; menemukan secara rekursif direktori yang berisi `.git` (kedalaman ≤ 6) |
| `excludes` | Nama direktori yang dilewati (default termasuk node_modules) |
| `manualRepos` | Path repo yang ditambahkan secara manual, di luar roots yang dikonfigurasi |
| `tags` / `favorites` / `groupOverrides` | Override tag / favorit / grup per-repo-id |
| `notes` / `archived` | Catatan / flag diarsipkan per-repo-id |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Template perintah untuk target open sekali klik (editor / terminal / explorer) |

Variabel lingkungan `REPO_RADAR_CONFIG` mengganti path file konfigurasi. Server hanya mendengarkan di `127.0.0.1` dan memvalidasi header Origin baik pada API maupun WebSocket.

## Tentang 365 Open Source Plan

Ini adalah proyek **#027** dari [365 Open Source Plan](https://github.com/rockbenben/365opensource).

Satu orang + AI, 300+ proyek open-source dalam setahun. [Ajukan ide Anda →](https://365.aishort.top/)

## Lisensi

[MIT](../../LICENSE)
