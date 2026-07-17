<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Kế hoạch 365 Open Source #027 · Một bảng điều khiển (dashboard) Git cục bộ — một hàng đợi hành động (action queue) xuyên suốt các repo, trả lời câu hỏi điều gì cần bạn xử lý ngay bây giờ.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · **Tiếng Việt** · [Bahasa Indonesia](README.id.md)

Một bảng điều khiển (dashboard) Git cục bộ quét toàn bộ repo trên máy của bạn và đưa lên một màn hình duy nhất: một **hàng đợi hành động (action queue)** xuyên suốt các repo, trả lời câu hỏi *điều gì cần bạn xử lý ngay bây giờ* — nhấp vào một mục là xử lý trực tiếp. Giao diện được xây dựng trên antd 6 với chủ đề buồng lái thiết bị (instrument-cockpit) đậm chất kỹ thuật.

## Bắt đầu nhanh

```bash
npm install
npm run build   # build phần frontend
npm start       # http://localhost:7420
```

Ở lần khởi chạy đầu tiên, một file cấu hình mặc định sẽ được tạo tại `~/.repo-radar/config.json`. Chỉnh sửa `roots` để thêm các thư mục bạn muốn quét (ví dụ `D:\Projects` — hãy escape dấu backslash thành `D:\\Projects` trong JSON), sau đó nhấp **Rescan** trong panel.

## Needs you (màn hình khởi đầu)

Hàng đợi **Needs you** ở đầu bảng điều khiển là một hàng đợi hành động xuyên suốt các repo: được xếp hạng theo mức độ khẩn cấp, mỗi repo chỉ hiện một mục — điều cấp bách nhất, chứ không phải một dashboard "đếm số commit" phù phiếm khác.

- **Waiting on you**: các PR mở của người khác, issue mở của người khác, CI đỏ trên nhánh mặc định (được tổng hợp ngầm qua `gh` đã đăng nhập sẵn cục bộ, làm mới mỗi 12 phút, hoặc ↻ thủ công; các PR/issue mở của chính bạn được tính là WIP và bị loại trừ) — nhấp vào một mục để nhảy thẳng đến trang GitHub tương ứng
- **At risk of being lost**: xung đột / bị tụt lại (behind) / chưa commit / chưa push, càng nằm im lâu thì thứ hạng càng cao — công việc chưa push có nút push một chạm, các trường hợp khác mở panel chi tiết
- **Overdue for release**: các repo có thói quen gắn tag mà đã tích lũy ≥3 commit kể từ tag mới nhất mà chưa có bản phát hành — một lời nhắc để ship (các repo chưa bao giờ gắn tag sẽ được bỏ qua; tag mới nhất được chọn theo thời điểm tạo trên toàn bộ repo, không phụ thuộc vào nhánh hiện tại)
- **Forgotten stash**: một stash nằm im không động tới ≥7 ngày — nhấp để đi thẳng đến hộp thư stash
- **Dismiss**: nhấn ✓ để xóa một mục cho đến khi có gì đó mới xảy ra — các mục dựa trên số đếm cần số đếm tăng lên, các mục dựa trên thay đổi cần thêm một commit; việc dismiss một stash chỉ là hoãn (snooze) và sẽ xuất hiện lại sau 30 ngày để một stash thực sự bị bỏ quên không bao giờ bị im lặng vĩnh viễn
- Mở rộng quá 10 mục để xem tất cả; hiển thị "all clear" khi không còn gì. Thu gọn thành một banner mỏng ở trên cùng

## Board

- **Cards**: mỗi repo một card (tối đa 4 card mỗi hàng, chiều cao bằng nhau). Màu viền trái = tình trạng sức khỏe (xanh lá = yên ắng / hổ phách = cần chú ý / đỏ = báo động). Hiển thị tên thật · mô tả · ngôn ngữ · nhánh (gắn cờ nếu không phải main) · phân tích cây làm việc (`+staged ~modified`) · ahead/behind · các tag sức khỏe · commit gần nhất · liên kết remote · tag. Footer luôn có nút một chạm **editor / terminal / folder**
- **Favorites row**: một hàng "★ favorites" riêng ở đầu board — nhấp để mở trong editor của bạn
- **Readout cluster**: các đồng hồ đo FLEET / CRIT / WARN / CLEAN trên thanh trên cùng; số lượng cảnh báo sáng lên khi > 0
- **Click to filter**: nhấp vào ngôn ngữ hoặc `#tag` của một card để đưa nó thẳng vào ô tìm kiếm
- **Sort**: mở gần nhất / hoạt động gần đây nhất (theo thời điểm commit) / theo tên — favorites luôn nổi lên trên cùng
- **Attention lamps**: các chip trên thanh trên cùng tóm tắt loại vấn đề (không có remote / detached HEAD / chưa push / chưa commit / behind / stash); nhấp để lọc. "Unpushed" và "behind" mỗi cái đều có nút "push/pull tất cả" một chạm
- **Grouping**: theo thư mục / theo ngôn ngữ / không nhóm (phẳng)
- **Command palette ⌘/Ctrl-K**: một launcher — gõ tên, nhấn enter để mở trong editor của bạn (có nút inline cho terminal / folder / copy path / open remote)
- **Tag filter**: chọn nhiều tag trên thanh trên cùng (theo kiểu AND — phải mang mọi tag đã chọn); nhấp vào `#tag` của một card để thêm nó. Filter + sort + grouping được lưu cùng nhau thành một "view" có tên
- **Inline preview**: nút "⋯" trên card hiện lên các commit gần đây mà không cần mở panel chi tiết
- **Auto-scan (mặc định tắt)**: một nút gạt "manual ⟳ / auto ⟳" trên thanh trên cùng. Khi bật, một file watcher sẽ tự động làm mới các card bị ảnh hưởng (thời gian chờ 60 giây; các thay đổi trong lúc chờ được gộp lại, không bao giờ bị bỏ sót). Khi tắt, trạng thái chỉ cập nhật khi Rescan. Board vẫn được lấp đầy bằng một lần quét ở lần khởi chạy đầu tiên
- **Scheduled fetch (mặc định tắt)**: "fetch: off / every 5–60 min" trên thanh trên cùng — định kỳ fetch mọi remote ở chế độ nền để giữ ahead/behind luôn mới
- **18 ngôn ngữ**: chuyển đổi ngôn ngữ giao diện từ ⚙ Settings (Trung Quốc giản thể/phồn thể, Anh, Nhật, Hàn, Tây Ban Nha, Pháp, Đức, Bồ Đào Nha, Nga, Ý, Ả Rập, Hindi, Bengal, Thái, Thổ Nhĩ Kỳ, Việt, Indonesia). Ở lần truy cập đầu tiên chưa có tùy chọn được lưu, giao diện sẽ tự khớp với ngôn ngữ trình duyệt của bạn (mặc định về tiếng Anh nếu không khớp gì cả); tiếng Ả Rập tự động chuyển sang RTL. Thời gian tương đối được bản địa hóa gốc qua `Intl`. Tên repo, mô tả và commit message luôn được giữ nguyên, không dịch

## Hành động

- Footer của card luôn hiển thị các nút editor / terminal / folder / copy-path; mở một cái sẽ ghi lại dấu thời gian "last opened" dùng để sắp xếp
- Fetch / pull (`--ff-only`) / push chạy theo lô: chọn nhiều card → thực hiện hành động theo lô từ thanh trên cùng, hoặc nhấp một chạm vào toàn bộ đèn chú ý "unpushed" / "behind". Tiến trình hiển thị trực tiếp; một repo lỗi không làm dừng các repo còn lại
- **Chạy một lệnh trên nhiều repo**: chọn card, gõ một lệnh trong toolbar (ví dụ `npm install`), lệnh chạy song song trong thư mục của mỗi repo đã chọn. "Dry run" xem trước repo nào sẽ bị ảnh hưởng; "view output" hiển thị kết quả theo từng repo sau đó
- **Stash inbox**: khi có bất kỳ stash nào đang tồn tại, một liên kết "stash inbox (N)" sẽ xuất hiện trên thanh trên cùng — liệt kê mọi thay đổi đã stash trên mọi repo, kèm diff cho từng mục, `apply` / `pop` / `drop`
- Chọn nhiều card cũng cho phép bạn áp dụng tag hàng loạt
- **Xuất/nhập manifest**: xuất toàn bộ manifest repo (path + remote + group + tag) từ **+ new** để sao lưu/chuyển máy; nhập lại sẽ nhận diện các repo đã tồn tại cục bộ và liệt kê những repo chưa có để clone
- Lệnh mở có thể cấu hình riêng cho từng đích trong `open` trong config.json; `{path}` được thay thế bằng đường dẫn repo
- **+ New**: gợi ý số thứ tự tiếp theo (ví dụ `028-`) và thư mục cha của các dự án đã đánh số hiện có của bạn, sau đó tạo thư mục, chạy `git init`, viết một README, và quét lại nó vào board

## Kiểm tra sức khỏe & thống kê

- Các rule (conflicted / no remote / detached HEAD / uncommitted / unpushed / untracked / behind / stash / stale) có thể bị tắt riêng lẻ qua `health.disabledRules`; `staleDays` đặt ngưỡng "stale"
- **Mergeable branches**: card gắn cờ số lượng nhánh cục bộ đã được merge vào HEAD (không tính nhánh hiện tại và main/master); panel chi tiết cung cấp dọn dẹp `git branch -d` một chạm (chỉ bao giờ xóa các nhánh đã được merge — an toàn)
- **GitHub (tùy chọn, qua `gh` đã đăng nhập sẵn cục bộ)**: hàng đợi "needs you" tổng hợp PR mở / issue mở / CI nhánh mặc định cho mọi remote `github.com` ở chế độ nền (polling giới hạn tốc độ, lưu trên đĩa, tức thời khi khởi động lại). Panel chi tiết cũng có thể truy vấn chi tiết PR mở và lần chạy CI mới nhất theo yêu cầu; mô tả repo được điền bổ sung từ GitHub khi có sẵn
- Tab **Stats**: bản đồ nhiệt commit xuyên suốt các repo trong một năm (chỉ nhánh cục bộ), hoạt động gần đây nhất, và 10 repo lâu không động tới nhất
- Tab **Worklog**: chọn một khoảng thời gian để xem dòng thời gian commit xuyên suốt các repo (có thể lọc theo tác giả — mặc định "chỉ mình tôi" bằng cách tự động phát hiện danh tính git của bạn), với nút copy một chạm dưới dạng báo cáo tuần Markdown
- Nhấp vào một card để mở panel chi tiết: phân tích sức khỏe đầy đủ, các nhánh có thể merge, **chuyển / tạo / hủy nhánh cục bộ**, **commit tại chỗ** (gõ một message, nó sẽ commit) với diff trực tiếp của các thay đổi đang chờ, PR/CI GitHub, bản đồ nhiệt mini 12 tuần, commit gần đây, stash, và remote

## Sắp xếp repo

- Gắn sao ★ cho một card để đưa vào favorite (nổi lên trên cùng); thêm/xóa tag trong panel chi tiết (tự động gợi ý từ các tag bạn đã dùng) và đổi nhóm của nó ("auto" khôi phục về nhóm suy ra từ thư mục)
- **Notes / to-dos**: ghi chú "việc tiếp theo" trong panel chi tiết — nó hiển thị trên card
- **Exclude**: ẩn các repo bạn không muốn thấy; các repo bị loại trừ sẽ được ẩn khỏi board, cảnh báo, và command palette theo mặc định. "Excluded (N)" trên thanh trên cùng cho phép bạn xem/quản lý chúng riêng (bỏ loại trừ từ panel chi tiết)
- Các thay đổi được áp dụng ngay lập tức và được ghi vào config.json mà không kích hoạt quét Git lại

## Phát triển

```bash
npm run dev     # chạy server(7420) + vite(5173) cùng lúc, frontend proxy /api
npm test        # bộ test đầy đủ cho server + web và cả hai typecheck
```

Stack: Node + Hono (mọi thao tác git đều qua `spawn`, không phụ thuộc native nào), Vite + React 19 + antd 6 (tùy biến sâu qua CSS variables), chokidar + WebSocket cho cập nhật trực tiếp.

## Cấu hình (config.json)

| Trường | Mô tả |
| --- | --- |
| `roots` | Các thư mục gốc để quét; tự động phát hiện đệ quy các thư mục chứa `.git` (độ sâu ≤ 6) |
| `excludes` | Tên thư mục cần bỏ qua (mặc định bao gồm node_modules) |
| `manualRepos` | Đường dẫn repo được thêm thủ công, nằm ngoài các root đã cấu hình |
| `tags` / `favorites` / `groupOverrides` | Ghi đè tag / favorite / group theo từng repo |
| `notes` / `archived` | Ghi chú / cờ archived theo từng repo |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Mẫu lệnh cho các đích mở một chạm (editor / terminal / explorer) |

Biến môi trường `REPO_RADAR_CONFIG` ghi đè đường dẫn file cấu hình. Server chỉ lắng nghe trên `127.0.0.1` và xác thực header Origin trên cả API lẫn WebSocket.

## Giới thiệu về 365 Open Source Plan

Đây là dự án **#027** của [365 Open Source Plan](https://github.com/rockbenben/365opensource).

Một người + AI, hơn 300 dự án mã nguồn mở trong một năm. [Gửi ý tưởng của bạn →](https://365.aishort.top/)

## Giấy phép

[MIT](../../LICENSE)
