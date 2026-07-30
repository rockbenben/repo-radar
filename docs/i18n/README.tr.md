<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — tüm Git repolarınızı izleyen ve sizi bekleyenleri işaretleyen yerel bir pano" />
</p>

# repo-radar

> Tüm Git repolarınızı izleyen ve hangilerinin sizi beklediğini gösteren yerel bir pano.

[![365 Open Source Plan #027](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

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
- **Bir repoya derinlemesine dalın** — detay paneli tam bir sağlık dökümü, branch değiştirme / oluşturma / atma, canlı diff ile **yerinde commit**, talep üzerine GitHub PR ve CI, son commit'ler, stash'ler, 12 haftalık ısı haritası ve halihazırda birleştirilmiş branch'lerin tek tıkla temizliğini sunar — bu temizlik yalnızca `main`/`master` üzerindeyken önerilir, çünkü «halihazırda birleştirilmiş»in «ana dala birleştirilmiş» ile örtüştüğü tek konum orasıdır. Değişiklikleri atmak izlenen dosyaları geri alır ve izlenmeyenleri siler, ancak alt modüllerin içeriğine ve izlenmeyen iç içe git depolarına dokunmaz; geride bir şey kalırsa başarı bildirmek yerine bunu söyler.
- **Güncel kalın** — varsayılan yenileme yolu, 30 dakikada bir dönen tam tarama ile araç çubuğundaki elle tarama. Dosya izlemeli otomatik tarama ise **varsayılan olarak kapalı**, gerekirse ayarlar panelinden açılır: yalnızca yereldir ve ağa hiç dokunmaz, ama aynı anda birkaç proje derlenirken çekirdeğin bildirim tamponu sürekli taşar ve her taşma bir taramaya mal olur — neyin değiştiğine şöyle bir bakmak için kullanılan bir araca göre fazla yüksek, sürekli ödenen bir bedel. Açıldığında Windows ve macOS'ta tarama dizini başına tek bir özyinelemeli izleme, altındaki tüm depoları kapsar; böylece bir depoyu eklemek, silmek veya yeniden adlandırmak saniyeler içinde görünür. Linux'ta depolar tek tek izlenir ve `watchLimit` (varsayılan 200, 0 = sınırsız) kaç tanesinin izleneceğini sınırlar, favorilere ve son commit atılanlara öncelik verir. Taşmalar sürerse telafi taramalarının arası üstel olarak açılır (en sık 30 dakikada bir) ve izleme artık yeniden kurulmaz — bu yalnızca bir izleme hedefi gerçekten kaybolduğunda olur. 30 dakikada bir dönen tam tarama izlemenin kaçırdığını toplar, araç çubuğunda «son tarama» görünür ve ayarlar paneli kapsamı canlı olarak («N repodan M izleniyor») gösterir. Bir depoyu yeniden adlandırmak veya taşımak etiketlerini, yıldızını, arşiv durumunu ve notlarını korur — repo-radar yalnızca yolu değil, kimliği izler. Eşleştirme taşımadan **hemen sonraki** tarama turunda yapılır; bu da iki boşluk bırakır: iki tarama turuna yayılan, arada başka bir deponun eklenmesi/kaldırılması ya da periyodik tam taramanın denk geldiği yavaş bir birim-arası taşıma; ve hedefi o turda taranmayan bir taşıma — bir depoyu tarama dizinlerinizin dışına çıkarıp yeni yerini ancak daha sonra tarama dizini olarak eklemek buna düşmenin alışılmış yoludur. İkisi de yol tabanlı kimliğe geri döner: depo yepyeni bir kart olarak gelir ve etiketleri/yıldızı/arşivi/notları artık taşımadığı id'nin altında kalır. Zamanlanmış arka plan fetch ise isteğe bağlı. Ayrıca bir **İstatistikler** sekmesi (bir yıllık commit ısı haritası, en çok/en az aktif) ve bir tarih aralığını Markdown biçiminde haftalık rapor olarak kopyalayan bir **Çalışma günlüğü** sekmesi bulunur.
- **Repo başlatın ve taşıyın** — **+ New** bir sonraki numaralı projeyi önerir, `git init` çalıştırır, bir README yazar ve panoya alır; manifest dışa/içe aktarma kurulumunuzu makineler arasında taşır.

Arayüz, koyu bir kokpit-enstrüman temasında antd 6'dır ve 18 dile yerelleştirilmiştir (ilk ziyarette tarayıcınıza otomatik eşlenir, Arapça için RTL).

## Arka planda sessizce çalışır

Pencereyi kapatmak repo-radar'ı tray'e indirir, böylece dönemsel tam tarama, dosya izleme (açtıysanız), zamanlanmış fetch'ler ve GitHub uyarıları çalışmaya devam eder — panoyu geri getirmek için tray simgesine tıklayın veya tray menüsünden gerçekten çıkın. (Masaüstü tray'lerinin güvenilir olmadığı Linux'ta kapatmak bunun yerine çıkar; kalıcı tutmak için Girişte başlat'ı kullanın.)

Çıkışta repo-radar, hâlihazırda yürüyen git işinin — toplu bir pull, atılan bir stash, zamanlanmış bir fetch — bitmesini en fazla 10 saniye bekler; böylece hiçbir şey yazma ortasında kesilip geride eskimiş bir `.git/index.lock` bırakmaz. Bu süre yetmezse yine de çıkar ve bunu günlüğe yazar: daha sonra bulacağınız bir `index.lock`'u açıklayan tek yer orasıdır.

⚙ Ayarlar'da **Girişte başlat**'ı açın; oturumunuzla birlikte penceresiz başlar — siz isteyene kadar pencere yok. İsteğe bağlı masaüstü bildirimleri yalnızca kuyruğunuza *yeni* bir şey ulaştığında, pencere kapalıyken bile tetiklenir. Yükseltmeler tasarım gereği manueldir (otomatik güncelleme yok): yeni kurulum dosyasını eskisinin üzerine çalıştırın. Loglar `<config dir>/logs/repo-radar.log` dosyasına yazılır.

## Yapılandırma

Arayüzün dokunduğu her şey `~/.repo-radar/config.json` dosyasına kaydedilir — onu nadiren açmanız gerekir. Önemli alanlar:

| Alan | Ne işe yarar |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | nerede taranacağı (6 derinliğe kadar `.git` bulur, sembolik bağları izlemez), neyin atlanacağı ve köklerin dışında eklenen repolar — yeniden adlandırılan veya taşınan bir `manualRepos` girdisi, taranan bir repo gibi kimlikle izlenmez; yolunu burada güncelleyene kadar kart hata durumunda kalır ve taşıma bir tarama turundan daha eskiyse bu güncelleme kartı geri getirir ama etiketlerini/yıldızını/arşivini/notlarını getirmez |
| `health` | `{ staleDays, disabledRules }` — "eskimiş" eşiğini ayarlayın veya tek tek kontrolleri devre dışı bırakın |
| `open` | editör / terminal / klasör düğmeleri için komut şablonları (`{path}` = repo yolu) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | arka plan davranışı — varsayılan olarak yalnızca `autoScanMinutes` (30) açık; `autoWatch` dahil diğer üçü kapalı. `watchLimit` (200, 0 = sınırsız) **yalnızca Linux'ta** geçerlidir; orada depolar tek tek izlenir. Windows ve macOS tarama dizini başına bir özyinelemeli izleme kullanır ve her zaman tüm depoları kapsar |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | repo başına düzenleme |

`config.json` yanında iki dosya daha var; ikisi de güvenle silinebilir — repo-radar bunları yeniden oluşturur, ama maliyetleri farklıdır. `repo-cache.json` her deponun «ağır» git alanlarını (stash'ler, etiketler, remote'lar, birleştirilmiş branch'ler…) bir `.git` parmak iziyle eşleyerek hatırlar; böylece değişmemiş bir repo sonraki taramada o git çağrılarını atlar. Silmek yalnızca sonraki taramayı bir kez yavaşlatır. `repo-identity.json` ise kimlik defteridir; yeniden adlandırılan veya taşınan bir deponun yepyeni bir repo sayılmak yerine etiketlerini, yıldızını, arşiv durumunu ve notlarını korumasını sağlar. Buradaki kayıp ertelenmiş değil, anlıktır: dosya kaybolmadan **önce** yeniden adlandırılmış veya taşınmış olan her repo bir sonraki taramada yepyeni bir id alır ve etiketleri/yıldızı/arşivi/notları artık taşımadığı id'nin altında mahsur kalır. Hiç yeniden adlandırılmamış repolar etkilenmez ve defter yeniden oluşturulduğu andan itibaren yeniden adlandırmalar tekrar korumaya girer.

`REPO_RADAR_CONFIG` ve `REPO_RADAR_PORT` (varsayılan 17420) yapılandırma yolunu ve portu geçersiz kılar — ikinci ve tamamen bağımsız bir örnek çalıştırmak için **ikisini birden** ayarlayın. Sunucu yalnızca `127.0.0.1`'e bağlanır ve her API ve WebSocket isteğinde Origin başlığını doğrular.

Varsayılan port bilinçli olarak işletim sisteminin dinamik port aralığının üstünde: Windows varsayılan olarak 49152–65535 kullanır, ancak Hyper-V/WSL2 kurulduğunda bu aralık 1024–15000 olur ve sistem etkin aralıktan blok blok port rezerve eder — bu bloklardaki bir port `EACCES` ile bağlanamaz, üstelik bloklar her yeniden başlatmada yer değiştirir.

**Varsayılan** port yine de bağlanamazsa repo-radar başlamayı reddetmek yerine sıradaki adaya geçer (`+1000`, `+2000`, `+3000`, ardından sistemin atadığı bir port), yerleştiği portu hatırlayıp sonraki açılışlarda da onu kullanır ve ⚙ Ayarlar'da sürümün yanında gösterir. Hatırlaması önemlidir çünkü port, sayfanın origin'inin bir parçasıdır ve pano kayıtlı görünümleri, etkinlik günlüğünü, temayı ve dili origin'e bağlı tarayıcı deposunda tutar — portun gidip gelmesine izin vermek bu verilerin kaybolup geri gelmesi gibi görünmesine yol açar. Varsayılan porta dönmek için `<yapılandırma dizini>/port-state.json` dosyasını silin.

`REPO_RADAR_PORT` ile kendi belirlediğiniz port asla değiştirilmez — yer imlerinize, ters vekil sunucu upstream'lerinize ve betiklerinize verilmiş bir sözdür; bu yüzden bağlanamayan port açıkça hata verir. `npm run dev` için de aynısı geçerli: vite'ın vekil hedefi yapılandırma yüklenirken sabitlenir.

## Geliştirme

```bash
npm run dev     # vite + hot reload'lu uygulama penceresi
npm test        # server + web + desktop test paketleri ve tip kontrolleri
npm run dist    # dist-electron/ içine kurulum dosyaları derler
```

Yığın (stack): Electron kabuğu + Node + Hono (tüm git `spawn` üzerinden, sıfır native bağımlılık) + Vite / React 19 / antd 6, canlı güncellemeler için chokidar + WebSocket ile. Hono sunucusu Electron'un ana sürecinde çalışır ve pencere onu `127.0.0.1` üzerinden yükler; yani arayüz tarayıcıda olacağının aynısı — düz HTTP + WebSocket'tir.

## 365 Açık Kaynak Planı hakkında

[365 Açık Kaynak Planı](https://github.com/rockbenben/365opensource) kapsamındaki **#027** numaralı proje — bir kişi + yapay zeka, bir yılda 300'den fazla açık kaynak proje. [Fikrinizi paylaşın →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)