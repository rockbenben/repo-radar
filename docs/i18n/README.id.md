<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Papan repo·radar: lampu peringatan di atas, antrean «perlu tindakan» di bawahnya, lalu satu kartu per repo dengan branch, status working tree, dan editor / terminal / folder sekali klik" />
</p>

# repo-radar

> Rencana 365 Open Source #027 · Dasbor lokal yang mengawasi semua Git repo Anda dan menunjukkan mana yang butuh perhatian Anda.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · **Bahasa Indonesia**

[⬇ Unduh untuk Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Repo Git Anda sudah lebih banyak daripada yang bisa diingat sendiri. repo-radar mengawasi semuanya dan menunjukkan yang sedikit itu — yang memang butuh Anda sekarang. Sisanya boleh Anda lupakan.

Ia memunculkan hal-hal yang biasanya lupa Anda periksa:

- **Pekerjaan yang belum tuntas** — perubahan yang belum di-commit, belum di-push, atau tersimpan di stash, ditandai sebelum hilang.
- **GitHub sedang menunggu Anda** — PR terbuka, issue, dan CI merah, dibaca lewat `gh` Anda yang sudah login.
- **Proyek yang mulai dingin** — terlalu lama tak disentuh, atau rilisnya sudah lewat waktu.
- **Repo yang lepas dari pantauan** — semuanya dalam satu layar, bisa dicari, terbuka sekali klik.

Yang butuh tindakan naik ke atas sebagai antrean: satu entri per repo, diurutkan menurut urgensi. Tandai ✓ dan ia tidak kembali sampai benar-benar ada yang berubah — kecuali satu: stash yang ditandai muncul lagi setelah 30 hari, supaya stash yang benar-benar Anda lupakan tidak hilang selamanya.

## Dukungan

| Aspek | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Pemasangan | penginstal `.exe` | `.dmg` | `.AppImage` |
| Menutup jendela | masuk ke tray | masuk ke tray | keluar — pakai **Jalankan saat login** agar tetap aktif |
| Memantau perubahan | semua repo di bawah direktori pemindaian | sama | 200 repo pertama (batasnya bisa dinaikkan atau dilepas di setelan) |

Semuanya berjalan di komputer Anda dan memakai `git` yang sudah ada — tanpa akun, tanpa telemetri, tidak ada yang diunggah. Kolom GitHub (PR, issue, CI) opsional dan membaca lewat [`gh` CLI](https://cli.github.com/) tempat Anda sudah login; tanpa itu pun sisanya tetap jalan.

## Pemasangan

Ambil berkas untuk platform Anda dari [Releases](https://github.com/rockbenben/repo-radar/releases) — tidak perlu Node.js. Aplikasi ini tidak ditandatangani, jadi setiap sistem memberi peringatan saat pertama dijalankan:

- **Windows** — pada dialog SmartScreen klik *Info selengkapnya → Tetap jalankan*.
- **macOS** — klik kanan → Buka untuk pertama kali. Kalau macOS bilang rusak: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-*.AppImage` dulu.

Enggan percaya begitu saja pada berkas biner? [Bangun sendiri](../development.md) — cukup `npm install && npm start`.

Saat pertama dijalankan, klik **Tambah direktori pemindaian** lalu arahkan ke folder yang *memuat* repo Anda — misalnya `~/Projects`, bukan satu per satu repo. Ia menelusuri sampai 6 tingkat ke bawah mencari apa pun yang punya `.git`, dan papan pun terisi. Tanpa JSON, tanpa mulai ulang.

## Papan

Satu kartu per repo — warna kesehatan, branch, rincian working tree, ahead/behind, commit terakhir, tag — dengan **editor / terminal / folder** sekali klik.

- **Menemukannya** — cari, atau saring menurut bahasa, `#tag`, atau lampu sinyal. ⌘/Ctrl-K membuka peluncur.
- **Menyimpan tampilan** — filter + urutan + pengelompokan apa pun, diberi nama dan dipakai ulang.
- **Bertindak massal** — fetch / pull / push pada repo terpilih, atau satu perintah shell di semuanya. Satu repo gagal tidak pernah menghentikan sisanya.
- **Menggarap di tempat** — panel detail melakukan commit dengan diff langsung, ganti branch, buang perubahan, bersihkan branch yang sudah di-merge, dan menarik PR & CI GitHub sesuai permintaan.
- **Membuat dan memindahkan** — **+ Baru** membuat repo dan langsung menaruhnya di papan; ekspor / impor manifest memindahkan daftar repo — jalur, remote, grup, tag — ke mesin lain.

Lampu di bagian atas adalah jenis peringatan — tanpa remote, HEAD terpisah, belum di-push, belum di-commit, tertinggal dari remote, stash tersisa. Matikan yang tidak Anda perlukan di ⚙ Pengaturan.

Dua tab lagi: **Statistik** (heatmap commit setahun, repo paling aktif dan paling sepi) dan **Catatan kerja** (menyalin rentang tanggal sebagai laporan mingguan Markdown).

Tema gelap instrument-cockpit, dilokalkan ke 18 bahasa, kontras teks disetel ke WCAG AA di tema terang maupun gelap.

## Tetap mutakhir

Bawaannya: pemindaian ulang cadangan tiap 30 menit plus pemindaian manual dari toolbar. Pemindaian ulang hanya membaca keadaan git lokal — ia tidak pernah menghubungi remote untuk mencari tahu apa yang berubah.

Pemindaian otomatis lewat pemantauan berkas **mati secara bawaan** dan diaktifkan dari setelan. Ini pun lokal, tapi kalau beberapa proyek sedang dibangun bersamaan, buffer notifikasi kernel meluap terus, dan setiap luapan berarti event yang hilang dan tak bisa dipercaya lagi — satu-satunya jawaban aman adalah pemindaian ulang lagi, dibatasi backoff eksponensial paling banyak sekali tiap 30 menit. Tetap saja terlalu mahal sebagai biaya tetap untuk alat yang dipakai sekadar melihat apa yang berubah. Kalau diaktifkan, repo baru, terhapus, atau berganti nama muncul dalam hitungan detik.

Ganti nama atau pindahkan repo, tag, bintang, status arsip, dan catatannya ikut. repo-radar mengenali repo dari isinya, bukan dari letaknya — folder yang dipindah tetap proyek yang sama, bukan proyek baru.

Fetch latar terjadwal bersifat opsional dan satu-satunya fitur yang bicara dengan remote Anda atas inisiatif sendiri. Kolom GitHub adalah satu-satunya yang keluar jaringan mengikuti jam tanpa diminta: selama CLI `gh` terpasang, PR, issue, dan CI disegarkan melaluinya tiap 12 menit dan setelah setiap pemindaian ulang. Tanpa `gh`, atau tanpa remote GitHub, aplikasi sepenuhnya lokal.

## Berjalan tenang di latar

Menutup jendela menaruh repo-radar di tray **di Windows dan macOS**, sehingga pemindaian ulang, pemantauan, dan peringatan GitHub tetap berjalan; di Linux jendela justru keluar, sebab tray di sana tidak bisa diandalkan. Di Windows dan Linux, klik ikon tray memanggil papan kembali; di macOS ikon membuka menunya, tempat aksi itu menjadi entri pertama — dan tempat keluar berada di semua platform.

Saat keluar, ia menunggu hingga 10 detik untuk pekerjaan git yang sedang berlangsung — pull massal, penghapusan stash — supaya tidak ada yang terpotong di tengah penulisan dan meninggalkan `.git/index.lock` basi. Kalau masih kurang, ia tetap keluar dan mencatatnya di log.

Aktifkan **Jalankan saat login** dan ia mulai tanpa jendela bersama sesi Anda. Notifikasi desktop opsional dan hanya berbunyi ketika ada yang *baru* masuk ke daftar GitHub yang menunggu Anda — PR, issue, atau CI gagal; tidak pernah pada pemuatan pertama.

## Konfigurasi

Direktori pemindaian, folder yang dikecualikan, dan perintah buka bisa diubah di ⚙ Pengaturan → Pemindaian & perintah buka. Sisanya ada di `~/.repo-radar/config.json`, yang jarang perlu Anda buka; pilihan murni tampilan (tampilan tersimpan, tema, bahasa, catatan aktivitas) ada di penyimpanan peramban. Daftar lengkap field, berkas cache di sebelahnya, dan variabel lingkungan untuk menjalankan instance kedua ada di [referensi konfigurasi](../configuration.md).

## Batasan yang diketahui

- **Pembaruan sengaja dibuat manual.** Tidak ada auto-update: jalankan penginstal baru menimpa yang lama.
- **Pindah yang lolos dari pemindaian pengenalan meninggalkan petunjuk, bukan kehilangan diam-diam.** Saat pencocokan otomatis meleset, kartu baru menawarkan *«mungkin salinan yang dipindah dari jalur lama»* — klik **Pindahkan** dan tag, bintang, serta catatan ikut. Petunjuk hanya muncul untuk repo yang minimal sekali dipindai pada instalasi ini (buku besar perlu pernah melihat remote-nya) dan tidak pernah untuk tujuan yang belum Anda tambahkan sebagai direktori pemindaian.
- **Linux tidak punya tray yang bisa diandalkan**, jadi menutup jendela berarti keluar.
- **Repo yang ditambahkan satu per satu di luar direktori pemindaian tidak dikenali dengan cara ini** — kalau dipindah, Anda sendiri yang menunjuk path barunya.
- **Membuang perubahan tidak menyentuh submodule dan repo git bersarang**, dan ia mengatakannya alih-alih melapor bersih total.

## Tentang 365 Open Source Plan

Proyek **#027** dari [365 Open Source Plan](https://github.com/rockbenben/365opensource) — satu orang + AI, 300+ proyek open-source dalam setahun.

[Ajukan ide Anda →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
