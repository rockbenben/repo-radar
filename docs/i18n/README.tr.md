<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — tüm Git repolarınızı izleyen ve sizi bekleyenleri işaretleyen yerel bir pano" />
</p>

# repo-radar

> 365 Açık Kaynak Planı #027 · Tüm Git repolarınızı izleyen ve hangilerinin sizi beklediğini gösteren yerel bir pano.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · **Türkçe** · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Elle takip edebileceğinizden daha fazla Git reponuz var. repo-radar hepsine göz kulak olur ve şu anda sizi bekleyen birkaçını gösterir — böylece geri kalanı aklınızı meşgul etmez.

Aksi halde kontrol etmeyi unutacağınız şeyleri öne çıkarır:

- **İzini kaybettiğiniz repolar** — sahip olduğunuz her repo tek bir ekranda, aranabilir, herhangi biri tek tıkla açılır.
- **Yarım kalan işler** — commit edilmemiş, push edilmemiş veya stash'lenmiş değişiklikler, siz onları kaybetmeden işaretlenir.
- **GitHub sizi bekliyor** — her repodaki açık PR'lar, issue'lar ve başarısız CI, yerel ve zaten kimlik doğrulaması yapılmış `gh` üzerinden toplanır.
- **Bayatlayan projeler** — çok uzun süredir dokunmadıklarınız ya da yayınlaması gecikmiş olanlar.

İşlem gerektirenler, aciliyete göre sıralanmış bir kuyruk olarak panonun en üstüne çıkar, repo başına tek öğe — doğrudan işlem yapmak için tıklayın. ✓ ile kapatın; gerçekten bir şey değişene kadar gizli kalır; bekleyen bir şey olmadığında "her şey temiz" yazar. Geri kalan repolarınıza ise her zaman bir aramayla ulaşırsınız.

## Kurulum

Platformunuza uygun dosyayı [Releases](https://github.com/rockbenben/repo-radar/releases) üzerinden alın — Node.js gerekmez. Uygulama kod imzalı değildir, bu yüzden her işletim sistemi ilk çalıştırmada uyarır:

- **Windows** — `repo-radar-<version>-x64-setup.exe` dosyasını çalıştırın; SmartScreen isteminde *Daha fazla bilgi → Yine de çalıştır*'a tıklayın.
- **macOS** — `repo-radar-<version>-arm64.dmg` dosyasını açıp uygulamayı Applications'a sürükleyin. İlk seferde sağ tıklayıp → Aç; macOS bozuk olduğunu söylerse karantina bayrağını bir kez `xattr -cr /Applications/repo-radar.app` ile temizleyin.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Ya da kaynaktan çalıştırın:

```bash
npm install
npm start
```

İlk çalıştırmada **Tarama dizini ekle**'ye (veya ⚙ Ayarlar → Tarama dizinleri) tıklayın ve repolarınızı barındıran klasörleri gösterin — JSON yok, yeniden başlatma yok; kaydettiğiniz anda yeniden tarar. Elle düzenlemeyi tercih ederseniz ayarlar `~/.repo-radar/config.json` içindedir.

## Pano

Repo başına bir kart — sağlık rengi, branch, çalışma ağacı dökümü, ileride/geride, son commit, etiketler — ve her kartta tek tıkla **editör / terminal / klasör**. Buradan:

- **Bulun** — arayın, filtrelemek için bir dile / `#tag`'e / dikkat lambasına tıklayın, klasöre veya dile göre sıralayın ve gruplayın; herhangi bir filtre + sıralama + gruplamayı adlandırılmış bir görünüm olarak kaydedin. ⌘/Ctrl-K bir başlatıcı açar.
- **Toplu iş yapın** — fetch / pull (`--ff-only`) / push için repo seçin ya da hepsinde paralel olarak bir shell komutu çalıştırın (dry-run önizlemesi ve repo başına çıktı ile). Bir reponun başarısız olması diğerlerini asla durdurmaz.
- **Bir repoya derinlemesine dalın** — detay paneli tam bir sağlık dökümü, branch değiştirme / oluşturma / atma, canlı diff ile **yerinde commit**, talep üzerine GitHub PR ve CI, son commit'ler, stash'ler, 12 haftalık ısı haritası ve halihazırda birleştirilmiş branch'lerin tek tıkla güvenli temizliğini sunar.
- **Güncel kalın** — isteğe bağlı dosya izlemeli otomatik tarama ve zamanlanmış arka plan fetch, ikisi de varsayılan kapalı. Ayrıca bir **İstatistikler** sekmesi (bir yıllık commit ısı haritası, en çok/en az aktif) ve bir tarih aralığını Markdown biçiminde haftalık rapor olarak kopyalayan bir **Çalışma günlüğü** sekmesi bulunur.
- **Repo başlatın ve taşıyın** — **+ New** bir sonraki numaralı projeyi önerir, `git init` çalıştırır, bir README yazar ve panoya alır; manifest dışa/içe aktarma kurulumunuzu makineler arasında taşır.

Arayüz, koyu bir kokpit-enstrüman temasında antd 6'dır ve 18 dile yerelleştirilmiştir (ilk ziyarette tarayıcınıza otomatik eşlenir, Arapça için RTL).

## Arka planda sessizce çalışır

Pencereyi kapatmak repo-radar'ı tray'e indirir, böylece dosya izleme, zamanlanmış fetch'ler ve GitHub uyarıları çalışmaya devam eder — panoyu geri getirmek için tray simgesine tıklayın veya tray menüsünden gerçekten çıkın. (Masaüstü tray'lerinin güvenilir olmadığı Linux'ta kapatmak bunun yerine çıkar; kalıcı tutmak için Girişte başlat'ı kullanın.)

⚙ Ayarlar'da **Girişte başlat**'ı açın; oturumunuzla birlikte penceresiz başlar — siz isteyene kadar pencere yok. İsteğe bağlı masaüstü bildirimleri yalnızca kuyruğunuza *yeni* bir şey ulaştığında, pencere kapalıyken bile tetiklenir. Yükseltmeler tasarım gereği manueldir (otomatik güncelleme yok): yeni kurulum dosyasını eskisinin üzerine çalıştırın. Loglar `<config dir>/logs/repo-radar.log` dosyasına yazılır.

## Yapılandırma

Arayüzün dokunduğu her şey `~/.repo-radar/config.json` dosyasına kaydedilir — onu nadiren açmanız gerekir. Önemli alanlar:

| Alan | Ne işe yarar |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | nerede taranacağı (6 derinliğe kadar `.git` bulur), neyin atlanacağı ve köklerin dışında eklenen repolar |
| `health` | `{ staleDays, disabledRules }` — "eskimiş" eşiğini ayarlayın veya tek tek kontrolleri devre dışı bırakın |
| `open` | editör / terminal / klasör düğmeleri için komut şablonları (`{path}` = repo yolu) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | arka plan davranışı — hepsi varsayılan kapalı |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | repo başına düzenleme |

`REPO_RADAR_CONFIG` ve `REPO_RADAR_PORT` (varsayılan 7420) yapılandırma yolunu ve portu geçersiz kılar — ikinci ve tamamen bağımsız bir örnek çalıştırmak için **ikisini birden** ayarlayın. Sunucu yalnızca `127.0.0.1`'e bağlanır ve her API ve WebSocket isteğinde Origin başlığını doğrular.

## Geliştirme

```bash
npm run dev     # vite + hot reload'lu uygulama penceresi
npm test        # server + web + desktop test paketleri ve tip kontrolleri
npm run dist    # dist-electron/ içine kurulum dosyaları derler
```

Yığın (stack): Electron kabuğu + Node + Hono (tüm git `spawn` üzerinden, sıfır native bağımlılık) + Vite / React 19 / antd 6, canlı güncellemeler için chokidar + WebSocket ile. Hono sunucusu Electron'un ana sürecinde çalışır ve pencere onu `127.0.0.1` üzerinden yükler; yani arayüz tarayıcıda olacağının aynısı — düz HTTP + WebSocket'tir.

## 365 Açık Kaynak Planı hakkında

[365 Açık Kaynak Planı](https://github.com/rockbenben/365opensource) kapsamındaki **#027** numaralı proje — bir kişi + yapay zeka, bir yılda 300'den fazla açık kaynak proje. [Fikrinizi paylaşın →](https://365.aishort.top/)

## Lisans

[MIT](../../LICENSE)
