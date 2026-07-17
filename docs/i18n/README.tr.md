<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> 365 Açık Kaynak Planı #027 · Yerel bir Git repo panosu — şu anda sizi neyin beklediğini yanıtlayan, repolar arası bir eylem kuyruğu.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · **Türkçe** · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Makinenizdeki her repoyu tarayan ve karşınıza önce tek bir ekran çıkaran yerel bir Git repo panosu: *şu anda sizi neyin beklediğini* yanıtlayan repolar arası bir **eylem kuyruğu** — bir öğeye tıklayın ve doğrudan işlem yapın. Arayüz, koyu bir kokpit-enstrüman temasıyla antd 6 üzerine inşa edilmiştir.

## Hızlı başlangıç

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

İlk çalıştırmada `~/.repo-radar/config.json` konumunda varsayılan bir yapılandırma oluşturulur. Taranmasını istediğiniz dizinleri eklemek için `roots` alanını düzenleyin (ör. `D:\Projects` — JSON içinde ters eğik çizgileri `D:\\Projects` şeklinde escape edin), ardından panelde **Rescan**'e tıklayın.

## Needs you (giriş ekranı)

Panonun üstündeki **Needs you** kuyruğu, repolar arası bir eylem kuyruğudur: aciliyete göre sıralanır, repo başına tek öğe — "kaç commit var" türünden bir gösteriş panosu değil, en acil tek şey.

- **Sizi bekleyenler**: başkalarının açık PR'ları, başkalarının açık issue'ları, varsayılan branch'teki kırmızı CI (arka planda, yerel ve zaten kimlik doğrulaması yapılmış bir `gh` üzerinden toplanır, her 12 dakikada bir veya ↻ ile manuel olarak yenilenir; kendi açık PR/issue'larınız devam eden iş sayılır ve hariç tutulur) — bir öğeye tıklayarak doğrudan ilgili GitHub sayfasına gidin
- **Kaybolma riski taşıyanlar**: çakışmalar / geride kalmışlar / commit edilmemişler / push edilmemişler — ne kadar uzun süre öylece dururlarsa sıralamada o kadar yükselirler; push edilmemiş işler tek tıkla push edilir, geri kalanı detay panelini açar
- **Yayınlaması gecikmiş olanlar**: etiketleme alışkanlığı olan ve son etiketten bu yana ≥3 commit biriktirmiş, hâlâ yayınlanmamış repolar — bir yayınlama dürtmesi (hiç etiket kullanmayan repolar rahat bırakılır; en son etiket, mevcut branch'ten bağımsız olarak repo genelinde oluşturulma zamanına göre seçilir)
- **Unutulmuş stash**: ≥7 gündür dokunulmamış bir stash — doğrudan stash gelen kutusuna tıklayıp gidin
- **Kapat**: yeni bir şey olana kadar bir öğeyi temizlemek için ✓'ye dokunun — sayıya dayalı öğelerin sayının artması gerekir, değişime dayalı öğelerin ise yeni bir commit gerekir; bir stash'i kapatmak 30 gün sonra yeniden ortaya çıkan bir erteleme niteliğindedir, böylece gerçekten unutulmuş bir stash asla kalıcı olarak susturulmaz
- 10 öğenin ötesini görmek için genişletin; geriye bir şey kalmadığında "her şey temiz" gösterir. Üstte ince bir banda katlanır

## Board

- **Kartlar**: repo başına bir kart (satır başına en fazla 4, eşit yükseklikte). Sol kenar rengi = sağlık durumu (yeşil = sakin / kehribar = dikkat / kırmızı = alarm). Gerçek adı · açıklamayı · dili · branch'i (main değilse işaretli) · çalışma ağacı dökümünü (`+staged ~modified`) · ileride/geride olma durumunu · sağlık etiketlerini · son commit'i · uzak (remote) bağlantısını · etiketleri gösterir. Alt bilgide her zaman tek tıkla **editör / terminal / klasör** bulunur
- **Favoriler satırı**: panonun üstünde ayrılmış bir "★ favoriler" satırı — editörünüzde açmak için tıklayın
- **Gösterge kümesi**: üst çubukta FLEET / CRIT / WARN / CLEAN göstergeleri; alarm sayıları 0'dan büyük olduğunda yanar
- **Filtrelemek için tıklama**: bir kartın dilini veya `#tag`'ini tıklayarak doğrudan arama kutusuna aktarın
- **Sıralama**: son açılan / en son etkin olan (commit zamanına göre) / ada göre — favoriler her zaman en üste yüzer
- **Dikkat lambaları**: sorun türlerini özetleyen üst çubuk rozetleri (uzak yok / detached HEAD / push edilmemiş / commit edilmemiş / geride / stash); filtrelemek için tıklayın. "Push edilmemiş" ve "geride" için tek tıkla "hepsini push et/pull et" seçenekleri vardır
- **Gruplama**: klasöre göre / dile göre / gruplanmamış (düz)
- **Komut paleti ⌘/Ctrl-K**: bir başlatıcı — bir ad yazın, editörünüzde açmak için enter'a basın (satır içi terminal / klasör / yolu kopyala / uzağı aç düğmeleri)
- **Etiket filtresi**: üst çubukta çoklu seçim yapılan etiketler (VE mantığı — seçilen her etiketi taşımalıdır); bir kartın `#tag`'ini tıklayarak ekleyin. Filtre + sıralama + gruplama birlikte adlandırılmış bir "görünüm" olarak kaydedilir
- **Satır içi önizleme**: bir karttaki "⋯" detay panelini açmadan son commit'leri açılır pencerede gösterir
- **Otomatik tarama (varsayılan olarak kapalı)**: üst çubukta bir "manuel ⟳ / otomatik ⟳" anahtarı bulunur. Açıkken, bir dosya izleyici etkilenen kartları otomatik olarak yeniler (60 saniyelik bekleme süresi; bekleme sırasındaki değişiklikler asla kaybolmadan birleştirilir). Kapalıyken, durum yalnızca Rescan'de güncellenir. Pano ilk açılışta yine de tek bir tarama ile doldurulur
- **Zamanlanmış fetch (varsayılan olarak kapalı)**: üst çubukta "fetch: kapalı / her 5-60 dakikada bir" — ileride/geride bilgisini güncel tutmak için arka planda periyodik olarak her uzağı (remote) fetch eder
- **18 dil**: arayüz dilini ⚙ Ayarlar'dan değiştirin (Basitleştirilmiş/Geleneksel Çince, İngilizce, Japonca, Korece, İspanyolca, Fransızca, Almanca, Portekizce, Rusça, İtalyanca, Arapça, Hintçe, Bengalce, Tayca, Türkçe, Vietnamca, Endonezce). Kaydedilmiş bir tercih olmadan ilk ziyarette arayüz otomatik olarak tarayıcınızın diliyle eşleşir (hiçbiri eşleşmezse İngilizce'ye döner); Arapça otomatik olarak RTL'ye geçer. Göreli zamanlar `Intl` üzerinden yerel olarak yerelleştirilir. Repo adları, açıklamalar ve commit mesajları her zaman çevrilmeden bırakılır

## İşlemler

- Kart alt bilgisi her zaman editör / terminal / klasör / yolu kopyala düğmelerini gösterir; birini açmak sıralamada kullanılan bir "son açılma" zaman damgası kaydeder
- Fetch / pull (`--ff-only`) / push toplu olarak çalışır: birden çok kart seçin → üst çubuktan toplu işlem yapın, veya bir "push edilmemiş" / "geride" dikkat lambasının tamamını tek tıkla çalıştırın. İlerleme canlı olarak gösterilir; bir reponun başarısız olması diğerlerini durdurmaz
- **Repolar arasında komut çalıştırma**: kartları seçin, araç çubuğuna bir komut yazın (ör. `npm install`), seçilen her reponun dizininde paralel olarak çalışır. "Kuru çalıştırma" hangi reponun önce etkileneceğini önizler; "çıktıyı görüntüle" ardından repo başına sonucu gösterir
- **Stash gelen kutusu**: ortalıkta herhangi bir stash varsa, üst çubukta bir "stash gelen kutusu (N)" bağlantısı görünür — her repodaki her stash edilmiş değişikliği, öğe başına diff ile, `apply` / `pop` / `drop` seçenekleriyle listeler
- Birden çok kart seçmek ayrıca toplu etiket uygulamanıza da olanak tanır
- **Manifest dışa/içe aktarma**: yedekleme veya makine değiştirme için tam repo manifestini (yol + uzaklar + grup + etiketler) **+ new**'den dışa aktarın; içe aktarma, yerel olarak zaten var olan repoları yeniden benimser ve olmayanları klonlamak üzere listeler
- Açma komutu, config.json içinde `open` altında hedef başına yapılandırılabilir; `{path}` repo yolu ile değiştirilir
- **+ New**: bir sonraki sıra numarasını (ör. `028-`) ve mevcut numaralandırılmış projelerinizin üst dizinini önerir, ardından klasörü oluşturur, `git init` çalıştırır, bir README yazar ve panoya yeniden tarar

## Sağlık kontrolleri ve istatistikler

- Kurallar (çakışma / uzak yok / detached HEAD / commit edilmemiş / push edilmemiş / izlenmeyen / geride / stash / eskimiş) `health.disabledRules` üzerinden tek tek devre dışı bırakılabilir; `staleDays` "eskimiş" eşiğini belirler
- **Birleştirilebilir branch'ler**: kartlar, halihazırda HEAD'e birleştirilmiş yerel branch sayısını işaretler (mevcut branch ile main/master hariç); detay paneli tek tıkla bir `git branch -d` temizliği sunar (yalnızca zaten birleştirilmiş branch'leri siler — güvenlidir)
- **GitHub (isteğe bağlı, yerel ve zaten kimlik doğrulaması yapılmış bir `gh` üzerinden)**: "needs you" kuyruğu, her `github.com` uzağı için açık PR'ları / issue'ları / varsayılan branch CI'ını arka planda toplar (hız sınırlı yoklama, diske kalıcı olarak kaydedilir, yeniden başlatmada anında hazır). Detay paneli, açık PR detayını ve en son CI çalışmasını talep üzerine de sorgulayabilir; repo açıklamaları mevcut olduğunda GitHub'dan tamamlanır
- **İstatistikler** sekmesi: bir yıllık repolar arası commit ısı haritası (yalnızca yerel branch'ler), en son etkin olanlar ve en uzun süredir dokunulmamış 10 repo
- **Çalışma günlüğü** sekmesi: repolar arası bir commit zaman çizelgesi görmek için bir tarih aralığı seçin (yazara göre filtrelenebilir — git kimliğinizi otomatik algılayarak varsayılan olarak "yalnızca ben"), haftalık rapor olarak Markdown şeklinde tek tıkla kopyalama ile
- Detay panelini açmak için bir karta tıklayın: tam sağlık dökümü, birleştirilebilir branch'ler, **yerel branch'leri değiştirme / oluşturma / atma**, **yerinde commit** (bir mesaj yazın, commit eder) bekleyen değişikliklerin canlı diff'i ile, GitHub PR/CI, 12 haftalık mini ısı haritası, son commit'ler, stash'ler ve uzaklar

## Repoları düzenleme

- Bir kartı favorilemek için ★ ile yıldızlayın (en üste yüzer); detay panelinde etiket ekleyin/kaldırın (daha önce kullandığınız etiketlerden otomatik tamamlar) ve grubunu değiştirin ("auto" klasörden türetilen gruplamayı geri yükler)
- **Notlar / yapılacaklar**: detay panelinde "sırada ne var"ı not edin — kartta görünür
- **Hariç tutma**: görmek istemediğiniz repoları gizleyin; hariç tutulan repolar varsayılan olarak panodan, uyarılardan ve komut paletinden gizlenir. Üst çubuktaki "Hariç tutulanlar (N)" bunları ayrı olarak görüntülemenize/yönetmenize olanak tanır (detay panelinden hariç tutmayı kaldırın)
- Değişiklikler anında uygulanır ve bir Git yeniden taramasını tetiklemeden config.json'a yazılır

## Geliştirme

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

Yığın (stack): Node + Hono (tüm git erişimi `spawn` üzerinden, sıfır yerel bağımlılık), Vite + React 19 + antd 6 (CSS değişkenleri üzerinden derinlemesine özelleştirilmiş), canlı güncellemeler için chokidar + WebSocket.

## Yapılandırma (config.json)

| Alan | Açıklama |
| --- | --- |
| `roots` | Taranacak kök dizinler; `.git` içeren dizinleri özyinelemeli olarak keşfeder (derinlik ≤ 6) |
| `excludes` | Atlanacak dizin adları (varsayılanlar node_modules'i içerir) |
| `manualRepos` | Yapılandırılmış köklerin dışında, manuel olarak eklenen repo yolları |
| `tags` / `favorites` / `groupOverrides` | Repo kimliği başına etiket / favori / grup geçersiz kılmaları |
| `notes` / `archived` | Repo kimliği başına notlar / arşivlenmiş bayrağı |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Tek tıkla açma hedefleri için komut şablonları (editör / terminal / dosya gezgini) |

`REPO_RADAR_CONFIG` ortam değişkeni, yapılandırma dosyası yolunu geçersiz kılar. Sunucu yalnızca `127.0.0.1` üzerinde dinler ve hem API'de hem de WebSocket'te Origin başlığını doğrular.

## 365 Açık Kaynak Planı hakkında

Bu, [365 Açık Kaynak Planı](https://github.com/rockbenben/365opensource) kapsamındaki **#027** numaralı projedir.

Bir kişi + yapay zeka, bir yılda 300'den fazla açık kaynak proje. [Fikrinizi paylaşın →](https://365.aishort.top/)

## Lisans

[MIT](../../LICENSE)
