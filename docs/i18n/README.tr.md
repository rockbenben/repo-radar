<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="repo·radar panosu: üstte uyarı lambaları, altında «ilgi bekliyor» kuyruğu ve her depo için bir kart — dal, çalışma ağacı durumu ve tek tıkla düzenleyici / terminal / klasör" />
</p>

# repo-radar

> Tüm Git repolarınızı izleyen ve hangilerinin sizi beklediğini gösteren yerel bir pano.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · **Türkçe** · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[![365 Open Source Plan #027](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

[⬇ Windows · macOS · Linux için indir](https://github.com/rockbenben/repo-radar/releases/latest)

Git deponuz elle takip edebileceğinizden fazla. repo-radar hepsini gözler ve şu an sizi bekleyen birkaçını gösterir — gerisi aklınızdan çıkabilir.

Yoksa kontrol etmeyi unutacağınız şeyleri yüzeye çıkarır:

- **Yarım kalan iş** — commit edilmemiş, push edilmemiş ya da stash'e atılmış değişiklikler, siz kaybetmeden işaretlenir.
- **GitHub sizi bekliyor** — açık PR'lar, issue'lar ve kırmızı CI, zaten oturum açtığınız `gh` üzerinden okunur.
- **Soğuyan projeler** — çok uzun süredir dokunulmamış ya da sürümü gecikmiş olanlar.
- **Gözden kaçırdığınız depolar** — hepsi tek ekranda, aranabilir, tek tıkla açılır.

İlgi bekleyen her şey kuyruk olarak yukarı çıkar: depo başına bir kayıt, aciliyet sırasına göre. ✓ ile kapatın, gerçekten bir şey değişene kadar geri gelmez — tek istisna: kapatılan bir stash 30 gün sonra yeniden çıkar, böylece gerçekten unuttuğunuz bir stash kalıcı olarak kaybolmaz.

## Desteklenenler

| Yön | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Kurulum | `.exe` yükleyici | `.dmg` | `.AppImage` |
| Pencereyi kapatmak | tepsiye iner | tepsiye iner | çıkar — kalıcı olması için **Oturum açılışında başlat** |
| Değişiklik izleme | tarama dizini altındaki tüm depolar | aynısı | ilk 200 depo (sınır ayarlardan yükseltilebilir ya da kaldırılabilir) |

Her şey sizin makinenizde çalışır ve zaten kurulu olan `git`'i kullanır — hesap yok, telemetri yok, hiçbir şey yüklenmez. GitHub sütunu (PR, issue, CI) isteğe bağlıdır ve zaten oturum açtığınız [`gh` CLI](https://cli.github.com/) üzerinden okur; kullanmasanız da gerisi çalışır.

## Kurulum

Platformunuza ait dosyayı [Releases](https://github.com/rockbenben/repo-radar/releases) sayfasından alın — Node.js gerekmez. Uygulama imzalı olmadığı için her sistem ilk çalıştırmada uyarır:

- **Windows** — SmartScreen isteminde *Daha fazla bilgi → Yine de çalıştır*.
- **macOS** — ilk seferde sağ tık → Aç. macOS bozuk derse: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — önce `chmod +x repo-radar-*.AppImage`.

Bir ikili dosyaya öylece güvenmek istemiyor musunuz? [Kendiniz derleyin](../development.md) — `npm install && npm start` yeter.

İlk açılışta **Tarama dizini ekle**'ye tıklayın ve depolarınızın *içinde bulunduğu* klasörü gösterin — örneğin `~/Projeler`, tek tek depoları değil. İçinde `.git` olan her şeyi 6 seviye aşağıya kadar arar ve pano dolar. JSON yok, yeniden başlatma yok.

## Pano

Depo başına bir kart — sağlık rengi, dal, çalışma ağacı dökümü, ahead/behind, son commit, etiketler — her kartta tek tıkla **düzenleyici / terminal / klasör**.

- **Bulmak** — arayın ya da dile, `#tag`'e veya sinyal lambasına göre süzün. ⌘/Ctrl-K bir başlatıcı açar.
- **Görünüm kaydetmek** — herhangi bir süzgeç + sıralama + gruplama, adlandırılıp yeniden kullanılır.
- **Toplu iş yapmak** — seçili depolarda fetch / pull / push ya da hepsinde aynı kabuk komutu. Bir deponun hata vermesi diğerlerini asla durdurmaz.
- **Yerinde çalışmak** — ayrıntı paneli canlı diff ile commit alır, dal değiştirir, değişiklikleri atar, birleştirilmiş dalları temizler ve GitHub PR & CI'yi istendiğinde çeker.
- **Depo kurmak ve taşımak** — **+ Yeni** bir depo oluşturup doğrudan panoya koyar; manifest dışa / içe aktarımı depo listenizi — yollar, remote'lar, gruplar, etiketler — başka bir makineye taşır.

Üstteki lambalar uyarı türleridir — uzak yok, ayrık HEAD, push edilmemiş, commit edilmemiş, uzaktan geride, stash kalmış. İlgilenmediklerinizi ⚙ Ayarlar'dan kapatın.

İki sekme daha: **İstatistik** (bir yıllık commit ısı haritası, en hareketli ve en durgun depolar) ve **Çalışma günlüğü** (bir tarih aralığını Markdown haftalık rapor olarak kopyalar).

Koyu kokpit-enstrüman teması, 18 dile yerelleştirilmiş, metin kontrastı hem açık hem koyu temada WCAG AA'ya göre ayarlanmış.

## Güncel kalmak

Varsayılan: 30 dakikada bir yedek yeniden tarama ve araç çubuğundaki elle tarama. Yeniden tarama yalnızca yerel git durumunu okur — neyin değiştiğini anlamak için asla bir remote'a ulaşmaz.

Dosya izlemeli otomatik tarama **varsayılan olarak kapalıdır**, ayarlardan açılır. O da yereldir, ama birkaç proje aynı anda derlenirken çekirdeğin bildirim tamponu sürekli taşar ve taşma, o olayların kaybolup artık güvenilememesi demektir — tek güvenli yanıt bir yeniden tarama daha, üstel geri çekilmeyle en fazla 30 dakikada bire sınırlı. Yine de "neyin değiştiğine bir bakayım" aracı için fazla yüksek bir sabit bedel. Açtığınızda eklenen, silinen veya adı değişen depolar saniyeler içinde görünür.

Bir deponun adını değiştirin ya da taşıyın; etiketleri, yıldızı, arşiv durumu ve notları kalır. repo-radar bir depoyu içindekinden tanır, durduğu yerden değil — taşınan bir klasör hâlâ aynı projedir, yenisi değil.

Zamanlanmış arka plan fetch isteğe bağlıdır ve kendiliğinden sizin remote'larınızla konuşan tek özelliktir. GitHub sütunu, istenmeden saatli olarak ağa çıkan tek şeydir: `gh` CLI kurulu olduğu sürece PR'lar, issue'lar ve CI onun üzerinden her 12 dakikada bir ve her yeniden taramadan sonra tazelenir. `gh` yoksa veya GitHub remote yoksa uygulama tamamen yereldir.

## Arka planda sessizce çalışır

Windows ve macOS'ta pencereyi kapatmak repo-radar'ı tepsiye indirir; yeniden taramalar, izleme ve GitHub uyarıları sürer. Linux'ta pencereyi kapatmak uygulamayı kapatır — orada güvenilir bir tepsi yok. Windows ve Linux'ta tepsi simgesine tıklayınca pano geri gelir; macOS'ta simge kendi menüsünü açar ve bu onun ilk seçeneğidir — Çıkış da her platformda o menüde.

Çıkarken hâlihazırda süren git işini — toplu pull, stash silme — en fazla 10 saniye bekler; böylece hiçbir şey yazmanın ortasında kesilip eski bir `.git/index.lock` bırakmaz. Yetmezse yine de çıkar ve bunu günlüğe yazar.

**Oturum açılışında başlat**'ı açın; oturumunuzla birlikte penceresiz başlar. Masaüstü bildirimleri isteğe bağlıdır ve yalnızca GitHub'daki sizi bekleyen listesine *yeni* bir şey geldiğinde çalar — PR, issue veya düşen CI; ilk yüklemede asla.

## Yapılandırma

Tarama dizinleri, hariç tutulan klasörler ve açma komutları ⚙ Ayarlar → Tarama ve açma komutları altından düzenlenir. Gerisi `~/.repo-radar/config.json` içindedir ve nadiren açmanız gerekir — salt görüntüye dair seçimler (kaydedilmiş görünümler, tema, dil, etkinlik günlüğü) tarayıcı deposunda durur. Tüm alan listesi, yanındaki önbellek dosyaları ve ikinci bir örnek çalıştırmak için ortam değişkenleri [yapılandırma referansında](../configuration.md).

## Bilinen sınırlar

- **Yükseltmeler bilinçli olarak elle yapılır.** Otomatik güncelleme yok: yeni yükleyiciyi eskisinin üzerine çalıştırın.
- **Tanıyan taramanın kaçırdığı taşınma, sessiz bir kayıp değil bir ipucu bırakır.** Otomatik eşleşme tutmadığında yeni kart *«eski yolun taşınmış bir kopyasına benziyor»* sunar — **Taşı**'ya basın, etiketler, yıldız ve notlar peşinden gelsin. İpucu yalnızca bu kurulumda en az bir kez taranmış depolar için devreye girer (defter onların remote'unu görmüş olmalı) ve henüz tarama dizini olarak eklemediğiniz bir hedef için asla.
- **Linux'ta güvenilir bir tepsi yok**, bu yüzden pencereyi kapatmak uygulamayı kapatır.
- **Tarama dizini dışında tek tek eklenen depolar bu yolla tanınmaz** — birini taşırsanız yeni yolu siz gösterirsiniz.
- **Değişiklikleri atmak alt modüllere ve iç içe git depolarına dokunmaz**; tertemiz bir sonuç bildirmek yerine bunu söyler.

## 365 Açık Kaynak Planı hakkında

[365 Açık Kaynak Planı](https://github.com/rockbenben/365opensource) kapsamındaki **#027** numaralı proje — bir kişi + yapay zeka, bir yılda 300'den fazla açık kaynak proje.

[Fikrinizi paylaşın →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
