<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — một bảng điều khiển cục bộ theo dõi tất cả các repo Git của bạn và đánh dấu những repo cần đến bạn" />
</p>

# repo-radar

> Kế hoạch 365 Open Source #027 · Một bảng điều khiển cục bộ theo dõi tất cả các repo Git của bạn và cho bạn biết cái nào cần đến bạn.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · **Tiếng Việt** · [Bahasa Indonesia](README.id.md)

Bạn có nhiều repo Git hơn mức có thể tự theo dõi xuể. repo-radar để mắt tới tất cả và chỉ cho bạn thấy vài cái đang cần đến bạn ngay lúc này — để bạn khỏi bận tâm đến những cái còn lại.

Nó nêu bật những thứ mà bình thường bạn hay quên kiểm tra:

- **Những repo bạn đã quên** — mọi repo bạn sở hữu trên một màn hình, có thể tìm kiếm, mở bất kỳ cái nào chỉ với một cú nhấp.
- **Việc còn dang dở** — các thay đổi chưa commit, chưa push, hoặc đang nằm trong stash, được đánh dấu trước khi bạn lỡ tay đánh mất.
- **GitHub đang chờ bạn** — các PR mở, issue và CI thất bại trên khắp các repo, được thu thập qua `gh` đã đăng nhập sẵn cục bộ của bạn.
- **Các dự án đang nguội dần** — những cái bạn đã quá lâu không đụng đến, hoặc quá hạn phát hành.

Những cái cần xử lý sẽ được đẩy lên đầu board thành một hàng đợi, xếp theo mức độ khẩn cấp, mỗi repo một mục — nhấp vào là xử lý được ngay. Gạt đi bằng ✓ thì nó biến mất cho đến khi thực sự có gì đó thay đổi; còn khi chẳng có gì phải chờ, nó báo "all clear". Các repo còn lại thì lúc nào cũng chỉ cần gõ tìm là ra.

## Cài đặt

Lấy file cho nền tảng của bạn từ [Releases](https://github.com/rockbenben/repo-radar/releases) — không cần Node.js. Ứng dụng chưa được ký mã (code-sign), nên hệ điều hành nào cũng sẽ cảnh báo ở lần chạy đầu tiên:

- **Windows** — chạy `repo-radar-<version>-x64-setup.exe`; ở lời nhắc SmartScreen, bấm *More info → Run anyway*.
- **macOS** — mở `repo-radar-<version>-arm64.dmg` và kéo ứng dụng vào Applications. Nhấp chuột phải → Open ở lần đầu tiên; nếu macOS báo ứng dụng bị hỏng, hãy xóa cờ quarantine một lần bằng `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Hoặc chạy từ mã nguồn:

```bash
npm install
npm start
```

Ở lần khởi chạy đầu tiên, nhấp **Thêm thư mục quét** (hoặc ⚙ Cài đặt → Thư mục quét) rồi trỏ đến các thư mục chứa repo của bạn — không phải đụng tới JSON, không cần khởi động lại; vừa lưu là nó quét lại ngay. Cấu hình nằm ở `~/.repo-radar/config.json` nếu bạn thích tự sửa tay.

## Bảng điều khiển

Mỗi repo một card — màu sức khỏe, nhánh, phân tích cây làm việc, ahead/behind, commit gần nhất, tag — với **editor / terminal / folder** một chạm trên mọi card. Từ đây bạn:

- **Tìm** — tìm kiếm, nhấp vào một ngôn ngữ / `#tag` / đèn chú ý để lọc, sắp xếp và nhóm theo thư mục hoặc ngôn ngữ; lưu bất kỳ bộ lọc + sắp xếp + nhóm nào thành một view có tên. ⌘/Ctrl-K mở một launcher.
- **Hành động theo lô** — chọn repo để fetch / pull (`--ff-only`) / push, hoặc chạy song song một lệnh shell trên khắp chúng (với bản xem trước dry-run và output theo từng repo). Một repo lỗi cũng không bao giờ làm gián đoạn những repo còn lại.
- **Đào sâu vào một repo** — panel chi tiết cung cấp phân tích sức khỏe đầy đủ, chuyển / tạo / hủy nhánh, **commit tại chỗ** với diff trực tiếp, GitHub PR & CI theo yêu cầu, commit gần đây, stash, bản đồ nhiệt 12 tuần, và dọn dẹp an toàn một chạm các nhánh đã được merge.
- **Luôn cập nhật** — tự động quét khi tệp thay đổi được bật sẵn theo mặc định (chỉ cục bộ, không dùng mạng; bỏ qua `node_modules` và các thư mục kết quả build như `dist` / `obj` / `target`), kèm một lượt quét lại mỗi 30 phút để bù các sự kiện bị bỏ sót và dòng «quét lần cuối» trên thanh công cụ; vượt quá giới hạn theo dõi (mặc định 200, chỉnh được, có thể bỏ giới hạn) thì ưu tiên theo dõi repo yêu thích và mới commit, số còn lại dựa vào lượt quét lại — bảng cài đặt hiển thị đúng mức phủ («đang theo dõi M/N»). Fetch nền theo lịch là tùy chọn. Tab **Stats** (bản đồ nhiệt commit cả năm, hoạt động nhiều/ít nhất) và tab **Worklog** sao chép một khoảng ngày thành báo cáo tuần Markdown.
- **Khởi tạo & di chuyển repo** — **+ New** gợi ý dự án được đánh số tiếp theo, chạy `git init`, viết một README, và đưa nó vào board; xuất / nhập manifest mang thiết lập của bạn giữa các máy.

Giao diện là antd 6 với chủ đề buồng lái thiết bị (instrument-cockpit) tối, được bản địa hóa sang 18 ngôn ngữ (tự khớp với trình duyệt của bạn ở lần truy cập đầu tiên, RTL cho tiếng Ả Rập).

## Chạy âm thầm ở chế độ nền

Đóng cửa sổ sẽ đưa repo-radar xuống khay hệ thống (tray) để việc theo dõi tệp, fetch theo lịch và cảnh báo GitHub tiếp tục chạy — nhấp biểu tượng khay để đưa board trở lại, hoặc thoát hẳn từ menu khay. (Trên Linux, nơi khay desktop không đáng tin cậy, đóng cửa sổ sẽ thoát luôn; dùng Khởi động cùng đăng nhập để giữ nó thường trú.)

Bật **Khởi động cùng đăng nhập** trong ⚙ Cài đặt và nó khởi động không giao diện cùng phiên của bạn — không có cửa sổ cho đến khi bạn yêu cầu. Thông báo desktop tùy chọn chỉ kích hoạt khi có gì đó *mới* đến hàng đợi của bạn, ngay cả khi cửa sổ đang đóng. Việc nâng cấp cố ý để thủ công (không tự động cập nhật): chỉ cần chạy trình cài đặt mới đè lên bản cũ. Log được ghi vào `<config dir>/logs/repo-radar.log`.

## Cấu hình

Mọi thứ giao diện chạm tới đều được lưu vào `~/.repo-radar/config.json` — bạn hiếm khi cần mở nó. Các trường quan trọng:

| Trường | Chức năng |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | nơi quét (tìm `.git` sâu đến 6 cấp), cái gì bỏ qua, và các repo được thêm ngoài các root |
| `health` | `{ staleDays, disabledRules }` — chỉnh ngưỡng "stale" hoặc tắt từng kiểm tra riêng lẻ |
| `open` | mẫu lệnh cho các nút editor / terminal / folder (`{path}` = đường dẫn repo) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | hành vi nền — mặc định `autoWatch` bật, `autoScanMinutes` là 30 và `watchLimit` là 200 (0 = không giới hạn), hai mục còn lại tắt |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | sắp xếp theo từng repo |

`REPO_RADAR_CONFIG` và `REPO_RADAR_PORT` (mặc định 17420) ghi đè đường dẫn cấu hình và cổng — đặt **cả hai** để chạy một instance thứ hai hoàn toàn độc lập. Server chỉ bind `127.0.0.1` và xác thực header Origin trên mọi yêu cầu API và WebSocket.

Cổng mặc định được đặt cao hơn dải cổng động của hệ điều hành một cách có chủ đích: Windows mặc định dùng 49152–65535, nhưng thành 1024–15000 ngay khi cài Hyper-V/WSL2, và hệ thống giữ chỗ trọn từng khối trong dải đang hoạt động — cổng nằm trong đó sẽ bind thất bại với `EACCES`, và các khối này còn dịch chuyển sau mỗi lần khởi động lại.

Nếu vẫn không bind được cổng **mặc định**, repo-radar chuyển sang ứng viên kế tiếp (`+1000`, `+2000`, `+3000`, rồi để hệ điều hành cấp) thay vì từ chối khởi động, ghi nhớ cổng đã dùng và tái sử dụng ở những lần chạy sau, đồng thời hiển thị nó cạnh số phiên bản trong ⚙ Cài đặt. Việc ghi nhớ quan trọng vì cổng là một phần origin của trang, còn bảng điều khiển lưu các khung nhìn đã lưu, nhật ký hoạt động, giao diện và ngôn ngữ trong bộ nhớ trình duyệt gắn theo origin — để cổng nhảy qua nhảy lại sẽ khiến dữ liệu đó như biến mất rồi hiện lại. Xóa `<thư mục cấu hình>/port-state.json` để quay về cổng mặc định.

Cổng do bạn tự đặt qua `REPO_RADAR_PORT` không bao giờ bị thay — đó là cam kết với dấu trang, upstream reverse proxy và script của bạn, nên nếu không bind được thì nó báo lỗi rõ ràng. `npm run dev` cũng vậy, vì đích proxy của vite đã cố định từ lúc nạp cấu hình.

## Phát triển

```bash
npm run dev     # vite + cửa sổ ứng dụng với hot reload
npm test        # bộ test server + web + desktop và typecheck
npm run dist    # build trình cài đặt vào dist-electron/
```

Stack: lớp vỏ Electron + Node + Hono (mọi thao tác git đều qua `spawn`, không phụ thuộc native), + Vite / React 19 / antd 6, với chokidar + WebSocket cho cập nhật trực tiếp. Server Hono chạy bên trong tiến trình main của Electron và cửa sổ tải nó qua `127.0.0.1`, nên UI hoàn toàn là HTTP + WebSocket thuần — giống hệt như khi chạy trong trình duyệt.

## Giới thiệu về 365 Open Source Plan

Dự án **#027** của [365 Open Source Plan](https://github.com/rockbenben/365opensource) — một người + AI, hơn 300 dự án mã nguồn mở trong một năm. [Gửi ý tưởng của bạn →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)