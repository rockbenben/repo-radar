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

Yang butuh tindakan naik ke atas sebagai antrean: satu entri per repo, diurutkan menurut urgensi. Tandai ✓ dan ia tidak kembali sampai benar-benar ada yang berubah.

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
- **Membuat dan memindahkan** — **+ Baru** membuat repo dan langsung menaruhnya di papan; ekspor / impor manifest membawa konfigurasi Anda ke mesin lain.

Lampu di bagian atas adalah jenis peringatan — tanpa remote, belum di-push, belum di-commit, tertinggal dari remote, stash tersisa. Matikan yang tidak Anda perlukan di ⚙ Pengaturan.

Dua tab lagi: **Statistik** (heatmap commit setahun, repo paling aktif dan paling sepi) dan **Catatan kerja** (menyalin rentang tanggal sebagai laporan mingguan Markdown).

Tema gelap instrument-cockpit, dilokalkan ke 18 bahasa, kontras teks disetel ke WCAG AA di tema terang maupun gelap.

## Tetap mutakhir

Bawaannya: pemindaian ulang cadangan tiap 30 menit plus pemindaian manual dari toolbar — lokal, senyap, tanpa jaringan.

Pemindaian otomatis lewat pemantauan berkas **mati secara bawaan** dan diaktifkan dari setelan. Ini pun lokal, tapi kalau beberapa proyek sedang dibangun bersamaan, buffer notifikasi kernel meluap terus, dan setiap luapan berbiaya satu pemindaian ulang — terlalu mahal sebagai biaya tetap untuk alat yang dipakai sekadar melihat apa yang berubah. Kalau diaktifkan, repo baru, terhapus, atau berganti nama muncul dalam hitungan detik.

Ganti nama atau pindahkan repo, tag, bintang, status arsip, dan catatannya ikut. repo-radar mengenali repo dari isinya, bukan dari letaknya — folder yang dipindah tetap proyek yang sama, bukan proyek baru.

Fetch latar terjadwal bersifat opsional dan satu-satunya fitur yang menjangkau jaringan atas inisiatif sendiri.

## Berjalan tenang di latar

Menutup jendela menaruh repo-radar di tray, sehingga pemindaian ulang, pemantauan, dan peringatan GitHub tetap berjalan. Klik ikon tray untuk memanggil papan kembali, atau keluar lewat menunya.

Saat keluar, ia menunggu hingga 10 detik untuk pekerjaan git yang sedang berlangsung — pull massal, penghapusan stash — supaya tidak ada yang terpotong di tengah penulisan dan meninggalkan `.git/index.lock` basi. Kalau masih kurang, ia tetap keluar dan mencatatnya di log.

Aktifkan **Jalankan saat login** dan ia mulai tanpa jendela bersama sesi Anda. Notifikasi desktop opsional dan hanya berbunyi ketika ada yang *baru* masuk ke antrean.

## Konfigurasi

Direktori pemindaian, folder yang dikecualikan, dan perintah buka bisa diubah di ⚙ Pengaturan → Pemindaian & perintah buka. Sisanya ada di `~/.repo-radar/config.json`, yang jarang perlu Anda buka — daftar lengkap field, dua berkas cache di sebelahnya, dan variabel lingkungan untuk menjalankan instance kedua ada di [referensi konfigurasi](../configuration.md).

## Batasan yang diketahui

- **Pembaruan sengaja dibuat manual.** Tidak ada auto-update: jalankan penginstal baru menimpa yang lama.
- **Repo yang dipindah dikenali pada pemindaian berikutnya — kalau terlewat, tag-nya tidak ikut.** Pemindahan lambat antar-drive, atau tujuan yang belum Anda tambahkan sebagai direktori pemindaian, kembali sebagai kartu baru dan tag-nya tertinggal di kartu lama.
- **Linux tidak punya tray yang bisa diandalkan**, jadi menutup jendela berarti keluar.
- **Repo yang ditambahkan satu per satu di luar direktori pemindaian tidak dikenali dengan cara ini** — kalau dipindah, Anda sendiri yang menunjuk path barunya.
- **Membuang perubahan tidak menyentuh submodule dan repo git bersarang**, dan ia mengatakannya alih-alih melapor bersih total.

## Tentang 365 Open Source Plan

Proyek **#027** dari [365 Open Source Plan](https://github.com/rockbenben/365opensource) — satu orang + AI, 300+ proyek open-source dalam setahun.

[Ajukan ide Anda →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
