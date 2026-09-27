<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Bảng repo·radar: đèn cảnh báo ở trên, hàng đợi «cần bạn xử lý» bên dưới, rồi mỗi kho một thẻ với nhánh, trạng thái cây làm việc và mở trình soạn thảo / terminal / thư mục bằng một cú nhấp" />
</p>

# repo-radar

> Kế hoạch 365 Open Source #027 · Một bảng điều khiển cục bộ theo dõi tất cả các repo Git của bạn và cho bạn biết cái nào cần đến bạn.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · **Tiếng Việt** · [Bahasa Indonesia](README.id.md)

[⬇ Tải cho Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Bạn có nhiều kho Git hơn mức có thể tự nhớ hết. repo-radar trông chừng tất cả và chỉ đưa ra vài kho đang cần bạn ngay lúc này — số còn lại cứ để ngoài đầu.

Nó lôi ra những thứ mà bạn hay quên kiểm tra:

- **Việc còn dang dở** — thay đổi chưa commit, chưa push hoặc đang nằm trong stash, được đánh dấu trước khi bạn làm mất.
- **GitHub đang chờ bạn** — PR đang mở, issue và CI đỏ, đọc qua `gh` mà bạn đã đăng nhập sẵn.
- **Dự án đang nguội dần** — lâu quá không đụng tới, hoặc đã trễ hạn phát hành.
- **Kho bạn không còn để mắt tới** — tất cả trên một màn hình, tìm được, mở bằng một cú nhấp.

Thứ gì cần xử lý sẽ nổi lên đầu thành một hàng đợi: mỗi kho một mục, xếp theo mức khẩn. Gạt đi bằng ✓ và nó không quay lại cho tới khi thực sự có gì đó thay đổi — trừ một ngoại lệ: stash đã gạt sẽ quay lại sau 30 ngày, để cái bạn thực sự quên không biến mất vĩnh viễn.

## Phạm vi hỗ trợ

| Khía cạnh | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Cài đặt | trình cài `.exe` | `.dmg` | `.AppImage` |
| Đóng cửa sổ | thu vào khay hệ thống | thu vào khay hệ thống | thoát hẳn — dùng **Khởi động khi đăng nhập** để nó ở lại |
| Theo dõi thay đổi | toàn bộ kho dưới thư mục quét | như trên | 200 kho đầu tiên (nâng hoặc bỏ giới hạn trong cài đặt) |

Mọi thứ chạy trên máy bạn và dùng chính `git` bạn đang có — không tài khoản, không đo đạc từ xa, không gửi gì lên mạng. Cột GitHub (PR, issue, CI) là tùy chọn và đọc qua [`gh` CLI](https://cli.github.com/) nơi bạn đã đăng nhập; bỏ qua nó thì phần còn lại vẫn chạy.

## Cài đặt

Lấy tệp cho nền tảng của bạn ở [Releases](https://github.com/rockbenben/repo-radar/releases) — không cần Node.js. Ứng dụng không ký số nên mỗi hệ điều hành đều cảnh báo ở lần chạy đầu:

- **Windows** — ở hộp SmartScreen chọn *Thông tin thêm → Vẫn chạy*.
- **macOS** — lần đầu hãy chuột phải → Mở. Nếu macOS báo hỏng: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-*.AppImage` trước đã.

Không muốn tin một tệp nhị phân? [Tự biên dịch](../development.md) — chỉ là `npm install && npm start`.

Lần chạy đầu, nhấn **Thêm thư mục quét** rồi trỏ tới thư mục *chứa* các kho của bạn — kiểu `~/Projects`, chứ không phải thêm từng kho một. Nó lần xuống tối đa 6 cấp để tìm mọi thứ có `.git`, và bảng sẽ tự đầy. Không JSON, không khởi động lại.

## Bảng

Mỗi kho một thẻ — màu sức khỏe, nhánh, chi tiết cây làm việc, ahead/behind, commit gần nhất, thẻ nhãn — kèm **trình soạn thảo / terminal / thư mục** chỉ một cú nhấp.

- **Tìm ra nó** — tìm kiếm, hoặc lọc theo ngôn ngữ, `#tag` hay đèn cảnh báo. ⌘/Ctrl-K mở bộ khởi chạy.
- **Lưu một khung nhìn** — bộ lọc + sắp xếp + nhóm bất kỳ, đặt tên và dùng lại.
- **Xử lý hàng loạt** — fetch / pull / push trên các kho đã chọn, hoặc chạy cùng một lệnh shell trong tất cả. Một kho lỗi không bao giờ chặn phần còn lại.
- **Làm ngay tại chỗ** — bảng chi tiết cho commit kèm diff trực tiếp, đổi nhánh, bỏ thay đổi, dọn nhánh đã merge và lấy PR & CI của GitHub khi cần.
- **Tạo và di chuyển kho** — **+ Mới** tạo kho rồi đưa thẳng lên bảng; xuất / nhập manifest mang danh sách kho — đường dẫn, remote, nhóm, thẻ nhãn — sang máy khác.

Dãy đèn phía trên chính là các loại cảnh báo — không remote, HEAD tách rời, chưa push, chưa commit, tụt sau remote, còn stash. Tắt những cái bạn không quan tâm trong ⚙ Cài đặt.

Còn hai tab nữa: **Thống kê** (bản đồ nhiệt commit một năm, kho sôi động nhất và im ắng nhất) và **Nhật ký làm việc** (chép một khoảng ngày thành báo cáo tuần dạng Markdown).

Chủ đề buồng lái thiết bị tối màu, bản địa hóa sang 18 ngôn ngữ, độ tương phản chữ được canh theo WCAG AA ở cả chủ đề sáng lẫn tối.

## Luôn cập nhật

Mặc định là quét lại dự phòng mỗi 30 phút cộng với nút quét thủ công trên thanh công cụ. Một lượt quét chỉ đọc trạng thái git cục bộ — nó không bao giờ gọi tới remote để dò xem có gì thay đổi.

Quét tự động bằng theo dõi tệp **mặc định tắt**, bật trong cài đặt. Nó cũng chỉ chạy cục bộ, nhưng khi vài dự án cùng build thì bộ đệm thông báo của nhân hệ điều hành tràn liên tục, và mỗi lần tràn nghĩa là những sự kiện đã mất, không còn tin được nữa — câu trả lời an toàn duy nhất là thêm một lượt quét lại, giới hạn bằng backoff lũy thừa tối đa một lần mỗi 30 phút. Vẫn quá đắt để trả thường trực cho một công cụ chỉ để liếc xem có gì đổi. Bật lên thì kho mới thêm, bị xóa hay đổi tên hiện ra trong vài giây.

Đổi tên hoặc di chuyển một kho, thẻ nhãn, dấu sao, trạng thái lưu trữ và ghi chú vẫn theo. repo-radar nhận ra một kho bằng thứ nằm bên trong nó, không phải bằng vị trí — nên thư mục bị dời vẫn là đúng dự án đó, không phải một cái mới.

Fetch nền theo lịch là tùy chọn và là tính năng duy nhất tự nói chuyện với remote của bạn. Cột GitHub là thứ duy nhất tự ra mạng theo đồng hồ mà bạn không yêu cầu: khi CLI `gh` đã được cài, PR, issue và CI làm mới qua nó mỗi 12 phút và sau mỗi lượt quét. Không có `gh`, hoặc không có remote GitHub, ứng dụng hoàn toàn cục bộ.

## Chạy lặng lẽ ở nền

Đóng cửa sổ sẽ thu repo-radar vào khay hệ thống **trên Windows và macOS**, nên việc quét lại, theo dõi và cảnh báo GitHub vẫn tiếp tục; trên Linux cửa sổ thoát hẳn ứng dụng, vì ở đó không có khay đáng tin. Trên Windows và Linux, nhấn biểu tượng khay gọi bảng trở lại; trên macOS biểu tượng mở menu của nó, nơi hành động đó là mục đầu tiên — và nơi mục Thoát nằm trên mọi nền tảng.

Khi thoát, nó chờ tối đa 10 giây cho phần việc git đang chạy — một lượt pull hàng loạt, một stash bị xóa — để không có gì bị cắt giữa chừng và bỏ lại `.git/index.lock` cũ. Nếu vẫn không kịp, nó vẫn thoát và ghi rõ trong nhật ký.

Bật **Khởi động khi đăng nhập** thì nó chạy cùng phiên làm việc mà không hiện cửa sổ. Thông báo trên màn hình là tùy chọn và chỉ kêu khi có thứ *mới* rơi vào danh sách GitHub đang chờ bạn — PR, issue hoặc CI lỗi; không bao giờ ở lần tải đầu tiên.

## Cấu hình

Thư mục quét, thư mục loại trừ và lệnh mở đều sửa được trong ⚙ Cài đặt → Quét & lệnh mở. Phần còn lại nằm trong `~/.repo-radar/config.json`, thứ mà bạn hiếm khi phải mở; các lựa chọn thuần hiển thị (bộ nhìn đã lưu, chủ đề, ngôn ngữ, nhật ký hoạt động) nằm trong bộ nhớ của trình duyệt. Danh sách đầy đủ các trường, các tệp bộ nhớ đệm bên cạnh và biến môi trường để chạy một thực thể thứ hai đều ở [tài liệu tham khảo cấu hình](../configuration.md).

## Giới hạn đã biết

- **Nâng cấp là thủ công có chủ đích.** Không tự động cập nhật: chạy trình cài mới đè lên bản cũ.
- **Dời kho mà lượt quét không nhận ra sẽ để lại một gợi ý, chứ không âm thầm mất dữ liệu.** Khi việc tự ghép nối thất bại, thẻ mới hiện dòng *«có vẻ là bản dời từ đường dẫn cũ»* — bấm **Di dời** thì thẻ nhãn, sao và ghi chú đi theo. Gợi ý chỉ bật với kho đã được quét ít nhất một lần trên bản cài này (sổ ghi cần từng thấy remote của nó) và không bao giờ hiện ở đích mà bạn chưa thêm vào thư mục quét.
- **Linux không có khay hệ thống đáng tin cậy**, nên đóng cửa sổ là thoát hẳn.
- **Những kho bạn thêm lẻ từng cái, nằm ngoài thư mục quét, không được nhận diện theo cách này** — dời đi thì bạn tự trỏ lại đường dẫn mới.
- **Bỏ thay đổi sẽ không đụng tới submodule và kho git lồng bên trong**, và nó nói rõ điều đó thay vì báo đã dọn sạch.

## Giới thiệu về 365 Open Source Plan

Dự án **#027** của [365 Open Source Plan](https://github.com/rockbenben/365opensource) — một người + AI, hơn 300 dự án mã nguồn mở trong một năm.

[Gửi ý tưởng của bạn →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
