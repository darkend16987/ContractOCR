"use strict";

/*
 * Trang Hướng dẫn sử dụng (Trợ giúp → Hướng dẫn sử dụng · F1 · nút ? trên hàng 1).
 *
 * WHY THIS FILE EXISTS
 * The annotate bar used to carry a per-tool instruction sentence in #ed-hint, and the
 * text-edit bar an imperative tail in #te-hint. Those were removed at v0.2.53 and all of
 * that copy — plus everything the rest of the app never documented anywhere — lives here.
 * Two things that were wrong with the old arrangement and must not come back:
 *   1. A paragraph parked permanently in a flex toolbar. Squeezed to `min-width: 0` it
 *      rewrapped vertically and pushed .edit-bar to 381px tall, eating the page view
 *      (docs/REGRESSION-GUARD.md BI-41). Text that grows must not live in that bar.
 *   2. #ed-hint / #te-hint are in i18n.js's SKIP_IDS and editor.js never called I18N, so
 *      every one of those sentences stayed Vietnamese in English mode.
 *
 * DESIGN
 * - Content is DATA, not markup: `SECTIONS` below, every string a { vi, en } pair. Adding
 *   a feature means adding an entry here — nothing to wire, nothing in index.html.
 * - Rendered LAZILY on first open, so app startup is untouched, and re-rendered on
 *   `i18n:changed`.
 * - Because the DOM is built after i18n.js's buildRegistry() has already run (and it runs
 *   once, guarded by its `built` flag), the registry never sees these nodes. That is
 *   deliberate: this module owns its own translation, the modal carries `data-no-i18n`,
 *   and the two mechanisms cannot fight over the same text node.
 * - Shares the global scope with app.js (classic scripts) and reads nothing from it.
 *   Fully offline; no network, no IPC.
 */

(function () {
  const byId = (id) => document.getElementById(id);

  // Every human-visible string in this file. Keeping the pair inline (rather than two
  // parallel tables) is what makes a missing translation obvious while editing.
  const T = (vi, en) => ({ vi, en });

  // ---- chrome ---------------------------------------------------------------

  const UI = {
    title: T("Hướng dẫn sử dụng", "User Guide"),
    search: T("Tìm trong hướng dẫn…", "Search the guide…"),
    close: T("Đóng", "Close"),
    empty: T("Không có mục nào khớp từ khoá.", "No section matches that search."),
  };

  // ---- content --------------------------------------------------------------
  //
  // Block kinds: { h } sub-heading · { p } paragraph · { ul } bullets · { note } callout ·
  // { keys } shortcut rows [key, meaning] · { table } { head, rows }.
  // Inline markup inside any string: **bold** and `code`. Nothing else — see fmt().

  const SECTIONS = [
    {
      id: "start",
      title: T("Bắt đầu", "Getting started"),
      blocks: [
        {
          p: T(
            "Nabu PDF chạy **trên máy bạn**. Mọi việc xem, sửa, ghép/tách, chú thích, ký số đều không gửi file đi đâu. Chỉ **Bóc tách** và **Dịch tài liệu** cần mạng, vì hai tính năng đó gọi AI Google Gemini.",
            "Nabu PDF runs **on your own machine**. Viewing, editing, merging/splitting, annotating and signing never send your file anywhere. Only **Bóc tách** (contract extraction) and **Dịch tài liệu** (translation) need the internet, because those two call Google Gemini."
          ),
        },
        { h: T("Mở tài liệu", "Opening a document") },
        {
          ul: [
            T("Bấm **Mở** trên thanh công cụ, hoặc `Ctrl+O`.", "Click **Mở** on the toolbar, or press `Ctrl+O`."),
            T("**Kéo–thả** file PDF vào cửa sổ.", "**Drag and drop** a PDF onto the window."),
            T(
              "Trong Windows, bấm phải file PDF → **Open with** → **Nabu PDF**. (Bản cài đặt thêm Nabu vào danh sách Open-with; nó **không** tự giành làm trình xem mặc định.)",
              "In Windows, right-click a PDF → **Open with** → **Nabu PDF**. (The installer adds Nabu to the Open-with list; it does **not** take over as your default viewer.)"
            ),
          ],
        },
        { h: T("Tab và cửa sổ", "Tabs and windows") },
        {
          keys: [
            ["Ctrl+T", T("Tab mới", "New tab")],
            ["Ctrl+W", T("Đóng tab đang xem", "Close the current tab")],
            ["Ctrl+N", T("Cửa sổ mới", "New window")],
            ["Ctrl+Shift+W", T("Đóng cả cửa sổ", "Close the whole window")],
          ],
        },
        {
          p: T(
            "Menu **Tập tin** còn có **Tách ra cửa sổ riêng** và **Chuyển tới cửa sổ** để dời một tab sang cửa sổ khác. Muốn chọn file mới mở vào tab hay cửa sổ: **Cài đặt → Mở file mới trong**.",
            "The **Tập tin** (File) menu also has **Tách ra cửa sổ riêng** (move tab to a new window) and **Chuyển tới cửa sổ** (move tab to another window). To choose whether new files open in a tab or a window: **Cài đặt → Mở file mới trong**."
          ),
        },
        { h: T("Lưu", "Saving") },
        {
          ul: [
            T(
              "`Ctrl+S` **ghi đè** thẳng vào file đang mở. File kéo–thả chưa có đường dẫn thì app hỏi nơi lưu.",
              "`Ctrl+S` **overwrites** the file you opened. If the document came from a drag-and-drop and has no path yet, you are asked where to save."
            ),
            T("`Ctrl+Shift+S` **Lưu thành…** một file mới, giữ nguyên file gốc.", "`Ctrl+Shift+S` **Save As…** a new file, leaving the original untouched."),
            T(
              "Trên thanh công cụ, **Lưu** và **In** là hai nút **chỉ có biểu tượng** (đĩa mềm và máy in) — bỏ chữ đi để hàng trên gọn hơn. Rê chuột lên nút là hiện tên đầy đủ; hai lệnh này vẫn nằm trong menu **Tập tin** và trên `Ctrl+S` / `Ctrl+P`.",
              "On the toolbar, **Lưu** (Save) and **In** (Print) are **icon-only** buttons — a floppy disk and a printer — to keep the top row compact. Hover either one for its full name; both commands are still in the **Tập tin** (File) menu and on `Ctrl+S` / `Ctrl+P`."
            ),
            T(
              "Đóng cửa sổ khi còn thay đổi chưa lưu thì app hỏi **Lưu / Không lưu / Hủy** — không bao giờ mất im lặng.",
              "Closing a window with unsaved changes prompts **Save / Don't save / Cancel** — nothing is ever lost silently."
            ),
            T(
              "Nếu lần trước máy tắt đột ngột, lần mở sau app mời **khôi phục tài liệu chưa lưu**. Ba lựa chọn: **Khôi phục** · **Để sau** (giữ lại, lần sau hỏi tiếp) · **Xoá, không hỏi lại** (bỏ hẳn bản khôi phục — nút này ghi rõ sẽ xoá bao nhiêu bản).",
              "If the machine went down last time, the next launch offers to **recover unsaved documents**. Three choices: **Khôi phục** (recover) · **Để sau** (keep them, ask again next time) · **Xoá, không hỏi lại** (discard them for good — the button spells out how many it will delete)."
            ),
          ],
        },
        { h: T("Đóng nhanh một hộp thoại", "Closing a dialog quickly") },
        {
          p: T(
            "Mọi hộp thoại đều đóng được bằng **ba** cách, không phải kéo xuống cuối tìm nút: nhấn `Esc`, **bấm ra nền mờ** bên ngoài, hoặc bấm dấu **✕** ở góc trên bên phải. Cả ba đều tương đương nút **Hủy** — không có thay đổi nào bị ghi.",
            "Every dialog closes **three** ways, so you never have to scroll to the bottom to find a button: press `Esc`, **click the dimmed background** outside it, or click the **✕** in the top-right corner. All three do exactly what **Hủy** (Cancel) does — nothing is written."
          ),
        },
        { h: T("Hai badge trên thanh công cụ", "The two toolbar badges") },
        {
          ul: [
            T(
              "**OCR** — engine xử lý chạy trên máy. Lần đầu dùng OCR trên một máy mới, engine tải model về (cần mạng, mất một lúc). Đốm **đầy** = sẵn sàng.",
              "**OCR** — the local processing engine. The first time you use OCR on a new machine it downloads its models (needs the internet, takes a while). A **filled** dot means ready."
            ),
            T(
              "**API** — key AI cho Bóc tách / Dịch. Bấm vào badge để nhập key. Không có key thì mọi tính năng PDF + OCR + Searchable vẫn dùng bình thường.",
              "**API** — the AI key for extraction / translation. Click the badge to enter one. Without a key, every PDF + OCR + searchable-layer feature still works normally."
            ),
          ],
        },
        {
          note: T(
            "**Mở lại phiên trước:** bật ở **Cài đặt** thì lần khởi động sau app mở lại đúng các tab lần trước. Dải **đường dẫn file** dưới thanh công cụ cũng tắt được ở Cài đặt nếu muốn trang rộng thêm.",
            "**Reopen last session:** turn it on in **Cài đặt** (Settings) and the app restores your previous tabs on the next launch. The **file path strip** under the toolbar can also be switched off there to gain page area."
          ),
        },
      ],
    },

    {
      id: "view",
      title: T("Xem & điều hướng", "Viewing & navigation"),
      blocks: [
        { h: T("Phóng to / thu nhỏ", "Zoom") },
        {
          ul: [
            T("`Ctrl +` / `Ctrl −` / `Ctrl 0` — phóng to / thu nhỏ / về cỡ gốc 100%.", "`Ctrl +` / `Ctrl −` / `Ctrl 0` — zoom in / out / back to 100%."),
            T(
              "**Ctrl + lăn chuột** phóng to **bám theo con trỏ**. Trang bám tay ngay rồi tự làm nét khi bạn dừng lại.",
              "**Ctrl + mouse wheel** zooms **around the pointer**. The page follows your hand immediately, then sharpens once you stop."
            ),
            T("Gõ thẳng số vào ô zoom (20–500) rồi `Enter`.", "Type a percentage straight into the zoom box (20–500) and press `Enter`."),
            T(
              "**Vừa bề ngang** · **Vừa chiều dọc** · **Vừa cả trang** — ba nút cạnh ô zoom. \"Vừa chiều dọc\" hợp với văn bản khổ ngang.",
              "**Fit width** · **Fit height** · **Fit page** — the three buttons beside the zoom box. Fit height suits landscape documents."
            ),
          ],
        },
        { h: T("Di chuyển trong trang", "Moving around the page") },
        {
          ul: [
            T(
              "Công cụ **Bàn tay** (phím `H`) — kéo để dời trang. Phím `V` quay lại chế độ chọn chữ.",
              "The **hand** tool (`H`) — drag to move the page. `V` goes back to selecting text."
            ),
            T("**Giữ `Space`** để dùng bàn tay tạm thời, thả ra là về công cụ cũ.", "**Hold `Space`** to borrow the hand tool, release to return to the previous one."),
            T("**Kéo nút giữa chuột** thì dời trang được **mọi lúc**, không cần đổi công cụ.", "**Middle-mouse drag** pans **at any time**, no tool change needed."),
            T("`↑` / `↓` và `PageUp` / `PageDown` nhảy sang trang trước / trang kế.", "`↑` / `↓` and `PageUp` / `PageDown` jump to the previous / next page."),
          ],
        },
        { h: T("Cột trang & toàn màn hình", "Page list & full screen") },
        {
          ul: [
            T("`F4` ẩn / hiện cột trang. Kéo mép cột để đổi bề rộng, bấm đúp mép để về mặc định.", "`F4` hides / shows the page list. Drag its edge to resize, double-click the edge to reset."),
            T(
              "`F11` — **toàn màn hình**, trọn trang trong màn hình, ẩn thanh công cụ. `Esc` để thoát. Trong chế độ này, rê chuột vào **mép trái** thì dải trang trượt ra; `F4` để ghim nó lại.",
              "`F11` — **full screen** reading: the whole page on screen, toolbars hidden. `Esc` exits. In this mode, moving the pointer to the **left edge** slides the page strip out; `F4` pins it open."
            ),
            T(
              "Cuộn tới đâu, thumbnail trang đó **sáng lên** và cột trang tự trượt theo. Đây chỉ là dấu \"bạn đang ở đây\" — nó **không** đổi những trang bạn đã tick chọn, nên Xoá / Tách trang vẫn nhắm đúng.",
              "As you scroll, the matching thumbnail **lights up** and the list follows. That is only a \"you are here\" marker — it does **not** change which pages you ticked, so delete / extract still target your selection."
            ),
          ],
        },
        { h: T("Chia đôi màn hình — xem 2 tài liệu cùng lúc", "Split view — two documents at once") },
        {
          p: T(
            "`Ctrl+\\` chia cửa sổ làm đôi: **khung trái** là tài liệu bạn đang sửa, **khung phải** là một **khung xem chỉ đọc**. Dùng để đọc bản vẽ cũ trong khi đánh dấu bản mới — hoặc để mở **cùng một file** hai lần, xem trang 40 trong khi đang sửa trang 5.",
            "`Ctrl+\\` splits the window in two: the **left pane** is the document you are editing, the **right pane** is a **read-only view pane**. Use it to read the old drawing while marking up the new one — or to open the **same file** twice and read page 40 while editing page 5."
          ),
        },
        {
          ul: [
            T(
              "Bấm **tên file** trên đầu khung xem để đổi tài liệu: cùng tài liệu khung chính, một tab đang mở, hoặc **Mở file khác…**.",
              "Click the **filename** at the top of the view pane to change what it shows: the same document as the main pane, any open tab, or **Mở file khác…**."
            ),
            T(
              "**Kéo rãnh** giữa hai khung để đổi tỷ lệ. Tỷ lệ đó — và cả bố cục chia khung — được nhớ lại khi mở app lần sau.",
              "**Drag the divider** between the panes to change the ratio. That ratio — and the split itself — comes back the next time you open the app."
            ),
            T(
              "Khung xem hiển thị **bản đã lưu trên đĩa**, và nói rõ là bản lưu lúc mấy giờ. Bấm `Ctrl+S` ở khung chính là nó tự nạp lại, **giữ nguyên trang bạn đang đọc**.",
              "The view pane shows the file **as saved on disk**, and says which save you are looking at. Press `Ctrl+S` in the main pane and it reloads itself, **keeping the page you were reading**."
            ),
            T(
              "Khung xem **không sửa được** — đó là điều làm cho việc mở cùng một file hai lần an toàn: chỉ một khung ghi được, nên không có chuyện bản lưu này đè mất bản lưu kia. `Ctrl+S`, In, Hoàn tác **luôn** thuộc về khung chính.",
              "The view pane **cannot be edited** — that is what makes opening one file twice safe: only one pane can write, so one save can never eat another. `Ctrl+S`, Print and Undo **always** belong to the main pane."
            ),
            T(
              "Đang xem một file ở khung phải và muốn sửa nó? Bấm **Sửa file này** — nó chuyển sang khung chính, còn tài liệu đang sửa dời sang khung xem.",
              "Reading a file on the right and want to edit it? Press **Sửa file này** — it moves to the main pane, and the document you were editing moves to the view pane."
            ),
            T(
              "`Ctrl+Shift+\\` thêm khung xem thứ hai (tối đa 3 khung). `Ctrl+\\` lần nữa để đóng hết.",
              "`Ctrl+Shift+\\` adds a second view pane (three panes maximum). `Ctrl+\\` again closes them all."
            ),
            T(
              "Khung xem không nhận trang kéo sang — thả trang vào **khung chính**. Tài liệu có mật khẩu cũng phải mở ở khung chính.",
              "A view pane will not accept dragged pages — drop them on the **main pane**. A password-protected file has to be opened in the main pane too."
            ),
          ],
        },
        { h: T("Tìm trong tài liệu", "Find in document") },
        {
          p: T(
            "`Ctrl+F` đưa con trỏ vào ô tìm. `Enter` sang kết quả kế, `Shift+Enter` về kết quả trước, `Esc` xoá từ khoá và bỏ tô sáng. PDF scan cần chạy **OCR văn bản** trước mới tìm được chữ.",
            "`Ctrl+F` focuses the search box. `Enter` goes to the next match, `Shift+Enter` the previous one, `Esc` clears the query and the highlights. Scanned PDFs need **OCR văn bản** run on them first before there is any text to find."
          ),
        },
      ],
    },

    {
      id: "pages",
      title: T("Quản lý trang", "Managing pages"),
      blocks: [
        {
          p: T(
            "Tick chọn trang ở **cột trang** bên trái (nút **Chọn tất cả** ở đầu cột). Mọi lệnh dưới đây nằm trong nút **Trang ▾** trên thanh công cụ, và cũng có trong menu **Trang**.",
            "Tick pages in the **page list** on the left (**Chọn tất cả** selects all). Everything below is under the **Trang ▾** toolbar button, and also on the **Trang** menu."
          ),
        },
        { h: T("Thêm / ghép", "Adding & merging") },
        {
          ul: [
            T("**Ghép PDF khác vào…** · **Chèn trang từ PDF khác…** · **Thêm trang trắng…** — cả ba đều cho chọn vị trí (đầu / cuối / sau một trang).", "**Merge another PDF…** · **Insert pages from another PDF…** · **Add a blank page…** — all three let you choose the position (start / end / after a page)."),
            T(
              "**Gộp nhiều PDF thành một file** (nút ở màn hình rỗng): chọn nhiều file rồi **kéo–thả** hoặc nút ↑ / ↓ để sắp thứ tự. Không cần mở file nào trước.",
              "**Combine several PDFs into one** (the button on the empty screen): pick the files, then **drag** them or use ↑ / ↓ to order them. No document needs to be open first."
            ),
          ],
        },
        {
          note: T(
            "**Kéo nhiều file vào cửa sổ:** kéo vài file PDF từ Explorer thả vào cửa sổ Nabu → app hỏi **Mở từng file** hay **Gộp thành một file**. Chọn Gộp thì hộp thoại gộp mở ra đã điền sẵn, **đúng thứ tự bạn vừa kéo**. `Esc` là không làm gì cả. Kéo **một** file thì mở luôn như trước, không hỏi. (Kéo vào **dải trang** bên trái vẫn là **chèn trang** như cũ, không phải gộp.)",
            "**Drag several files onto the window:** drag a few PDFs from Explorer onto the Nabu window and it asks **Mở từng file** (open each) or **Gộp thành một file** (combine). Choose combine and the dialog opens pre-filled, **in the order you dragged them**. `Esc` does nothing. Dragging a single file just opens it, with no question. (Dropping onto the **page strip** on the left still means **insert pages**, not combine.)"
          ),
        },
        {
          note: T(
            "**Gộp ngay từ Explorer:** chọn nhiều file PDF trong Explorer → chuột phải → **Gộp bằng Nabu PDF** → hộp thoại gộp mở ra **đã điền sẵn** các file đó, trong một **tab mới** nên tài liệu đang đọc không bị đụng. Trên **Windows 11** mục này nằm trong **Hiện thêm tùy chọn** (hoặc bấm Shift+F10) — menu ngắn của Win11 chỉ nhận tiện ích đã ký số. Danh sách được sắp **theo tên** vì Windows không cho biết bạn đã chọn theo thứ tự nào, nên hãy kiểm lại thứ tự trước khi bấm **Gộp & lưu**. Windows ẩn mục menu nếu chọn quá 100 file; app nhận tối đa 60 file mỗi lượt và báo nếu phải bỏ bớt.",
            "**Combine straight from Explorer:** select several PDFs in Explorer, right-click, and choose **Gộp bằng Nabu PDF** — the combine dialog opens **already filled in** with those files, in a **new tab**, so whatever you were reading is untouched. On **Windows 11** the item lives under **Show more options** (or press Shift+F10): the short Win11 menu only accepts code-signed shell extensions. The list is ordered **by filename**, because Windows does not tell us the order you clicked them in — so check the order before pressing **Gộp & lưu**. Windows hides the menu item above 100 selected files; the app takes at most 60 per batch and says so when it has to drop any."
          ),
        },
        { h: T("Tách", "Splitting") },
        {
          ul: [
            T("**Tách trang đang chọn ra file mới** — những trang bạn tick thành một PDF riêng.", "**Extract selected pages to a new file** — the pages you ticked become their own PDF."),
            T("**Tách thành nhiều file…** — chia tài liệu thành nhiều PDF nhỏ, gói trong một `.zip`.", "**Split into several files…** — break the document into smaller PDFs, delivered as one `.zip`."),
          ],
        },
        { h: T("Biến đổi trang", "Transforming pages") },
        {
          ul: [
            T("**Xoay trái / phải 90°** cho các trang đang chọn.", "**Rotate left / right 90°** for the selected pages."),
            T("**Xoá trang đang chọn** (`Delete`).", "**Delete selected pages** (`Delete`)."),
            T(
              "**Xoá nhiều trang theo khoảng…** — nhập khoảng cần xoá rồi liệt kê những trang muốn **giữ lại** trong khoảng đó. Dòng xem trước cho biết sẽ xoá bao nhiêu trang, những trang nào, trước khi bạn bấm.",
              "**Delete a page range…** — give the range to remove, then list the pages inside it you want to **keep**. A live preview tells you how many pages and exactly which ones before you commit."
            ),
            T("**Đánh số trang…** — xem trước ngay trên trang, và `Ctrl+Z` hoàn tác được trước khi Lưu.", "**Add page numbers…** — previewed right on the page, and `Ctrl+Z` undoes it before you save."),
          ],
        },
        { h: T("Ẩn trang bằng mật khẩu (từ v0.2.64)", "Hiding pages behind a password (from v0.2.64)") },
        {
          ul: [
            T(
              "**Cách dùng** — chuột phải lên trang trong cột trang → **Ẩn trang này bằng mật khẩu…**. Đặt mật khẩu, nhập lại cho chắc, và có thể thêm một **gợi ý**. Trang biến thành một **trang giữ chỗ** in dòng “🔒 TRANG ĐÃ ẨN”, và thumbnail của nó mang dấu 🔒. Thanh trạng thái dưới cùng đếm “🔒 N trang đang ẩn”.",
              "**How** — right-click a page in the page list → **Ẩn trang này bằng mật khẩu…**. Set a password, confirm it, and optionally add a **hint**. The page becomes a **placeholder sheet** reading “🔒 TRANG ĐÃ ẨN”, its thumbnail gets a 🔒 badge, and the status bar counts “🔒 N trang đang ẩn”."
            ),
            T(
              "**Mở lại** — chuột phải lên trang có 🔒 → **Bỏ ẩn trang…**, nhập mật khẩu. Trang gốc quay lại **đúng vị trí cũ**, nguyên vẹn cả chú thích lẫn chiều xoay. Chọn nhiều trang cùng một mật khẩu thì mở lại một lượt.",
              "**Reopening** — right-click a page marked 🔒 → **Bỏ ẩn trang…** and type the password. The original comes back **in its own slot**, annotations and rotation intact. Select several pages sharing one password to reopen them in one go."
            ),
            T(
              "**Số trang không đổi.** Ẩn trang 7 của 12 thì tài liệu vẫn có 12 trang và trang 7 vẫn là trang 7 — mục lục, tham chiếu chéo và số trang đã đánh không lệch đi. Đây cũng là thứ giữ cho trang ẩn **đi theo trang của nó** khi bạn sắp xếp lại, ghép thêm file, tách file hay chuyển trang sang tài liệu khác.",
              "**The page count does not change.** Hide page 7 of 12 and the document still has 12 pages, with page 7 still at 7 — tables of contents, cross-references and stamped page numbers all stay true. It is also what keeps a hidden page **travelling with its own sheet** when you reorder, merge, split, or move pages to another document."
            ),
            T(
              "**Bảo mật thật, và giới hạn thật.** Nội dung trang được mã hoá **AES-256-GCM**, khoá dẫn xuất từ mật khẩu (PBKDF2-SHA256). Không có mật khẩu thì **không phần mềm nào** đọc được, kể cả Nabu. Đổi lại: **mất mật khẩu là mất trang**, không có đường khôi phục; **chỉ Nabu PDF** mở lại được (phần mềm khác chỉ thấy trang giữ chỗ); và **file không nhỏ đi**, vì bản mã hoá vẫn nằm trong đó.",
              "**Real protection, and real limits.** The page is encrypted with **AES-256-GCM** under a key derived from your password (PBKDF2-SHA256). Without the password **no software** can read it, Nabu included. In exchange: **lose the password and the page is lost**, with no recovery path; **only Nabu PDF** can reopen one (other software just sees the placeholder); and **the file does not get smaller**, because the encrypted copy still lives inside it."
            ),
            T(
              "**Ẩn xong thì `Ctrl+Z` không hoàn tác được** — đó là chủ ý. Lịch sử hoàn tác giữ một bản sao tài liệu **trước khi ẩn**, và file tự-lưu-phục-hồi cũng vậy; để nguyên thì bản gốc của trang bạn vừa ẩn vẫn nằm đó. Nên ẩn xong app xoá lịch sử và ghi đè bản phục hồi. Muốn trang trở lại, dùng chính mật khẩu vừa đặt.",
              "**After hiding, `Ctrl+Z` will not undo it** — deliberately. The undo history holds a copy of the document **from before the hide**, and so does the crash-recovery file; leaving either in place would keep the original of the page you just hid lying around. So the history is cleared and the recovery snapshot rewritten. To get the page back, use the password you just set."
            ),
            T(
              "**Gửi file ra ngoài mà không mang theo trang ẩn** — chuột phải → **Xuất bản sao KHÔNG kèm trang ẩn…**. Bản sao bỏ hẳn những trang đó, kể cả phần đã mã hoá; file đang mở không đổi.",
              "**Sending the file on without the hidden pages** — right-click → **Xuất bản sao KHÔNG kèm trang ẩn…**. The copy drops those pages entirely, ciphertext and all; the document you have open is untouched."
            ),
          ],
        },
        { h: T("Chuyển trang sang tài liệu khác", "Moving pages to another document") },
        {
          ul: [
            T(
              "**Kéo–thả giữa hai cửa sổ:** mở hai file ở **hai cửa sổ** (`Ctrl+N`, hoặc Cài đặt → mở file mới ở cửa sổ riêng), đặt cạnh nhau, rồi kéo một trang từ cột trang của cửa sổ này sang **khe giữa hai trang** ở cột trang của cửa sổ kia. Cột trang bên nhận sáng lên đúng khe sẽ chèn vào.",
              "**Drag between two windows:** open both files in **two windows** (`Ctrl+N`, or Settings → open new files in their own window), put them side by side, then drag a page from one window's page column onto the **gap between two pages** in the other's. The receiving column lights up the exact gap it will drop into."
            ),
            T(
              "**Mặc định là COPY** — tài liệu gốc **không mất trang**. Giữ `Shift` khi thả để **chuyển** hẳn, hoặc bấm **Xoá khỏi bản gốc** trên thông báo hiện ra sau khi copy.",
              "**Copy is the default** — the source document **keeps its pages**. Hold `Shift` as you drop to **move** them instead, or click **Remove from the original** on the message that appears after a copy."
            ),
            T(
              "Kéo **nhiều trang**: tick chọn các trang trước, rồi kéo **một trang trong số đó** — cả tập được chuyển.",
              "To move **several pages**: tick them first, then drag **any one of them** — the whole set travels."
            ),
            T(
              "**Không cần kéo:** chuột phải lên trang → **Chuyển trang này sang tài liệu khác…** rồi chọn tài liệu đích. Đường này còn tới được **tab khác trong cùng cửa sổ** — thứ mà kéo–thả không làm được, vì tab không hiện trên màn hình thì không có gì để thả vào. Trang được **nối vào cuối** tài liệu đích.",
              "**No drag needed:** right-click a page → **Move this page to another document…** and pick the destination. This route also reaches **another tab in the same window** — which dragging cannot, because a tab that is not on screen is nothing to aim at. The pages are **appended at the end** of the destination."
            ),
          ],
        },
        {
          note: T(
            "**Hai mẹo kéo–thả ở cột trang:**\n· **Sắp xếp:** kéo một trang thả lên trang khác để đổi vị trí.\n· **Chèn bằng kéo–thả:** kéo file `.pdf` từ Windows thả vào **khe giữa hai trang** — trang được chèn ngay chỗ đó (thả nửa trên = chèn phía trước, nửa dưới = phía sau). Thả nhiều file một lúc cũng được, khỏi mở hộp thoại.",
            "**Two drag-and-drop tricks in the page list:**\n· **Reorder:** drag a page onto another page to move it.\n· **Insert by drop:** drag a `.pdf` from Windows onto the **gap between two pages** — it is inserted right there (dropping on the upper half inserts before the page, the lower half after). Several files at once works too, with no dialog."
          ),
        },
        {
          note: T(
            "Cửa sổ đích **đang chú thích dở** hoặc **chưa mở file** thì không nhận trang — cấu trúc trang đang bị đóng băng. Nabu nói rõ lý do ở **cửa sổ bạn đang kéo**, chứ không phải ở cửa sổ bên kia. Nếu cột trang bên nhận đang thu gọn, **giữ con trỏ trên mép tab của nó một nhịp** là cột tự bung ra; kéo đi mà không thả thì nó thu lại như cũ.",
            "A destination that is **mid-annotation** or has **no document open** will not take pages — its page structure is frozen. Nabu says why in **the window you are dragging from**, not in the other one. If the receiving page column is collapsed, **rest the cursor on its edge tab for a moment** and it springs open; drag away without dropping and it closes again."
          ),
        },
      ],
    },

    {
      id: "annotate",
      title: T("Chú thích & đánh dấu", "Annotating & markup"),
      blocks: [
        {
          p: T(
            "Bấm **Chú thích** trên thanh công cụ để mở thanh công cụ chú thích. **Xong** ghi mọi thay đổi vào tài liệu; **Hủy bỏ** bỏ hết những gì chưa ghi. Trong lúc chú thích, `Ctrl+Z` / `Ctrl+Y` hoàn tác / làm lại **từng bước chú thích** (không phải từng trang).",
            "Click **Chú thích** on the toolbar to open the annotation bar. **Xong** writes everything into the document; **Hủy bỏ** discards anything not yet written. While annotating, `Ctrl+Z` / `Ctrl+Y` undo / redo **individual annotation steps** (not page operations)."
          ),
        },

        { h: T("Chọn, di chuyển, đổi cỡ", "Select, move, resize") },
        {
          ul: [
            T("Công cụ **Chọn** (phím `V`). **Kéo** một mục để di chuyển nó.", "The **select** tool (`V`). **Drag** an object to move it."),
            T(
              "**4 góc** để đổi cỡ. **Giữ `Shift`** khi kéo góc thì co giãn **đúng tỷ lệ**, không bị méo — áp dụng cho khoanh vùng chữ nhật / elip, tô sáng, ô che và ảnh.",
              "**The four corners** resize. **Hold `Shift`** while dragging a corner to keep the **aspect ratio** — this works for rectangles / ellipses, highlights, redaction boxes and images."
            ),
            T(
              "**Giữ `Ctrl` bấm** để thêm / bớt mục vào vùng chọn. Chọn nhiều mục thì **kéo một mục là cả nhóm đi theo**, đổi **Màu** hoặc **Nét** áp cho cả nhóm, và `Delete` xoá cả nhóm bằng **một** bước hoàn tác. Tay nắm đổi cỡ chỉ hiện khi chọn **một** mục — muốn đổi cỡ một mục trong nhóm thì bấm riêng nó trước.",
              "**Ctrl+click** adds or removes objects from the selection. With several selected, **dragging one moves the whole group**, changing **Màu** (colour) or **Nét** (line width) applies to all of them, and `Delete` removes the group in **one** undo step. Resize handles only appear for a **single** object — click one on its own to resize it."
            ),
            T(
              "`Ctrl+C` sao chép, sang trang khác — hoặc sang **file PDF khác đang mở ở tab/cửa sổ khác** — rồi `Ctrl+V` để dán. Hoặc **bấm chuột phải** lên mục để có menu **Sao chép / Dán vào trang này / Xoá mục**.",
              "`Ctrl+C` copies; go to another page — or to **another PDF open in another tab or window** — and `Ctrl+V` pastes. Or **right-click** an object for **Sao chép / Dán vào trang này / Xoá mục** (copy / paste here / delete)."
            ),
            T("`Delete` xoá mục đang chọn.", "`Delete` removes the selected object."),
            T(
              "`Esc` theo thứ tự: huỷ thao tác kéo đang làm → bỏ chọn → về công cụ **Chọn**. Nó **không bao giờ** tự thoát chế độ chú thích, nên không có đường mất việc ngoài ý muốn.",
              "`Esc` steps back in order: cancel the drag in progress → deselect → return to the **select** tool. It **never** exits annotation mode by itself, so there is no way to lose work by accident."
            ),
            T("**Bấm đúp** để sửa nội dung hộp văn bản, ghi chú, hoặc nhãn mũi tên.", "**Double-click** to edit a text box, a note, or an arrow's label."),
          ],
        },
        {
          note: T(
            "**Dán sang trang khác giữ đúng vị trí cũ** — tiện để lặp lại một khoanh mây hay một hộp chữ ở cùng chỗ trên nhiều trang. Dán lại trên **cùng** trang thì mỗi bản lệch xuống một chút cho khỏi đè nhau; dán vào trang **nhỏ hơn** thì cả nhóm tự lùi vào trong trang, không bị rời ra.\n\n**Sao chép được sang file PDF khác** — copy một hộp văn bản (hay mũi tên, khoanh mây, hình vẽ, và từ **v0.2.69** cả **dấu ✓ / ✗**) ở file này rồi `Ctrl+V` ở **tab khác** hoặc **cửa sổ khác**; nó giữ nguyên vị trí, cỡ và màu. Tab đích chưa bật **Chỉnh sửa** thì app tự bật giúp. Riêng **ảnh** chỉ dán được trong cùng một tab.\n\n**Clipboard không mất khi bấm Xong** — sao chép, bấm Xong, vẫn dán được. Nếu clipboard hệ điều hành đang có **ảnh** (copy từ app khác) thì `Ctrl+V` vẫn là dán ảnh vào trang như thường; hai đường không lẫn nhau.",
            "**Pasting onto another page keeps the original position** — handy for repeating a revision cloud or a text box at the same spot across pages. Pasting again on the **same** page offsets each copy slightly so they don't stack; pasting onto a **smaller** page nudges the whole group back inside the sheet without breaking it apart.\n\n**Copying into another PDF works too** — copy a text box (or an arrow, revision cloud, drawing, and from **v0.2.69** a **✓ / ✗ mark**) here and press `Ctrl+V` in **another tab** or **another window**; position, size and colour come across unchanged. If the destination tab is not in **Chỉnh sửa** yet, it is switched on for you. **Images** are the one exception: they paste only within the same tab.\n\n**The clipboard survives Xong** — copy, apply, and you can still paste. If the OS clipboard holds an **image** (copied from another app), `Ctrl+V` still pastes that image onto the page as before; the two paths never get confused."
          ),
        },

        { h: T("Từng công cụ một", "Tool by tool") },
        {
          ul: [
            T(
              "**Hộp văn bản** (`T`) — bấm lên trang để thêm, gõ nội dung, `Ctrl+Enter` để xong. Bảng **Định dạng văn bản** hiện bên phải: font, cỡ, đậm / nghiêng / gạch chân, căn lề, thụt lề, danh sách, và các nút căn giữa / sát mép trang.",
              "**Text box** (`T`) — click the page to place one, type, `Ctrl+Enter` to finish. The **Định dạng văn bản** panel appears on the right: font, size, bold / italic / underline, alignment, indent, lists, plus centre-on-page and snap-to-edge buttons."
            ),
            T(
              "**Xoay chữ (từ v0.2.63)** — chọn một hộp văn bản rồi gõ số độ vào ô **Xoay** trên thanh công cụ, hoặc bấm **+90°**. Số dương là **ngược chiều kim đồng hồ**. Xoay được **bất cứ lúc nào**: hộp vừa gõ xong, hộp đã bấm **Xong**, và hộp mở lại từ file đã lưu — góc đi theo file nên lần sau mở ra vẫn sửa lại được. Gõ lại nội dung thì ô nhập cũng nghiêng đúng góc đó, còn cỡ hộp thì **không** đổi theo góc: chữ chỉ đổi chiều, không phình ra.",
              "**Rotating the text (from v0.2.63)** — select a text box and type a number of degrees into the **Xoay** field on the toolbar, or press **+90°**. Positive turns **anti-clockwise**. You can rotate at **any time**: a box you have just typed, a box you already pressed **Xong** on, and a box reopened from a saved file — the angle travels with the file, so it is still adjustable next time. Retyping happens at the same angle, and the box's own size does **not** change with it: the text turns, it does not grow."
            ),
            T(
              "**Nền hộp văn bản (từ v0.2.64)** — hộp văn bản vốn trong suốt, nên đặt lên ảnh scan hay bản vẽ nhiều nét thì chữ lẫn vào hình. Bỏ tick **Không nền**, chọn **Nền** và kéo **Mờ nền** để lót một mảng màu phía sau chữ; để 100% là che kín, khoảng 70–85% thì vẫn thấy mờ mờ nội dung bên dưới. **Không nền** là công tắc tắt/bật cả lớp nền: tick là tắt hẳn, bỏ tick là bật lại **đúng màu và đúng độ mờ đang hiện trên thanh** — nên dùng nó để thử có/không nền mà không mất giá trị đã chọn. Kéo **Mờ nền** về 0% cũng là tắt nền, và ô **Không nền** tự tick theo để hai chỗ không nói ngược nhau. (Ô này trước đây ghi là **Trong suốt** — đổi tên vì cái tên cũ đọc như một mức của **Mờ nền**, mà nó là công tắc tắt/bật.) Nền ôm sát chữ, quay theo khi bạn xoay hộp, và **đi theo file** — mở lại vẫn sửa được. Hộp văn bản và hình khoanh vùng **nhớ riêng hai bộ màu nền**, nên đặt nền trắng cho chữ không làm khung chữ nhật vẽ sau đó cũng trắng. Đổi được **ngay trong lúc đang gõ**: khung đang gõ tô đúng màu và đúng độ mờ theo từng bước, hộp gõ không bị đóng, thả chuột là con trỏ về đúng chỗ. Ô vuông nhỏ cạnh thanh **Mờ nền** là bản xem trước trên ô kẻ caro — nên trắng 30% trông ra trắng 30%, còn thấy ô caro nghĩa là đang **Không nền**.",
              "**Text-box background (from v0.2.64)** — a text box is transparent by default, so words placed over a scan or a busy drawing get lost in the artwork. Untick **Không nền**, pick a **Nền** colour and drag **Mờ nền** to lay a wash behind the text: 100% hides what is underneath, around 70–85% still lets it show through faintly. **Không nền** is an on/off switch for the whole wash: tick it and the background is gone, untick it and it returns at **exactly the colour and opacity the bar is showing** — so it is the way to try with and without without losing your settings. Dragging **Mờ nền** to 0% also turns the background off, and the **Không nền** tick follows so the two controls cannot disagree. (This tick used to read **Trong suốt** — renamed because the old name read like a level of **Mờ nền**, when it is really an on/off switch.) The wash hugs the text, turns with the box when you rotate it, and **travels with the file** — reopen and it is still editable. Text boxes and shapes **remember two separate fill colours**, so setting a white wash for text does not make the next rectangle white too. You can change it **while you are still typing**: the field itself takes the colour and opacity as you go, the editor does not close, and the caret comes back where you left it. The small square next to **Mờ nền** previews it over a checkerboard — so white at 30% looks like white at 30%, and seeing the checkerboard means **Không nền** is on."
            ),
            T("**Tô sáng** (`H`) — kéo để tô sáng một vùng.", "**Highlight** (`H`) — drag across an area."),
            T(
              "**Vẽ tay** (`D`) — giữ chuột và kéo. **Giữ thêm `Shift`** thì đoạn đang vẽ duỗi **thẳng** từ chỗ bạn nhấn Shift tới con trỏ; **thả `Shift` ra là vẽ tay tiếp** từ đúng đầu mút đó. Một nét có thể vừa thẳng vừa nguệch ngoạc, không phải đổi công cụ.",
              "**Freehand** (`D`) — hold and drag. **Also holding `Shift`** straightens the current stretch from where you pressed Shift to the pointer; **release `Shift` and freehand carries on** from that same end point. One stroke can be part straight, part scribble, with no tool change."
            ),
            T("**Khoanh vùng chữ nhật** (`R`) và **elip / tròn** (`O`) — kéo để khoanh. Đổi **Nền** và **Mờ nền** nếu muốn tô màu bên trong; bỏ tick **Không nền** để bật nền. Ba control này chạy đúng luật như nền hộp văn bản ở trên — tick **Không nền** là tắt tạm, bỏ tick là màu và độ mờ cũ trở lại y nguyên.", "**Rectangle** (`R`) and **ellipse / circle** (`O`) — drag to draw. Use **Nền** and **Mờ nền** to fill it; untick **Không nền** to enable the fill. The three controls follow exactly the same rules as the text-box background above — ticking **Không nền** mutes the fill, un-ticking brings the same colour and opacity straight back."),
            T(
              "**Khoanh mây** (`C`) — kéo để khoanh một **revision cloud** quanh vùng cần lưu ý (chuẩn kỹ thuật / xây dựng). Thanh **Cỡ mây** kéo nhỏ thì mây ken đặc, sát viền hơn.",
              "**Revision cloud** (`C`) — drag to cloud the area you want flagged (the engineering / construction convention). The **Cỡ mây** slider: smaller arcs sit denser and hug the outline more tightly."
            ),
            T(
              "**Khoanh mây tự do** (`F`) — hai cách dùng: **giữ chuột kéo** để vẽ tự do, hoặc **bấm từng điểm** rồi đóng mây bằng cách bấm vào **điểm đầu**, nhấn `Enter`, hoặc **bấm đúp**. `Esc` để huỷ. Trong lúc bấm từng điểm, thanh công cụ hiện dòng nhắc cách đóng.",
              "**Freehand cloud** (`F`) — two ways: **hold and drag** to draw freely, or **click point by point** and close it by clicking the **first point**, pressing `Enter`, or **double-clicking**. `Esc` cancels. While you are clicking points, the bar shows a reminder of how to close it."
            ),
            T(
              "**Mũi tên** (`A`) — kéo từ gốc tới đích. Thả ra là hiện ô nhập **nhãn** ngay ở đầu mũi tên (gõ rồi `Enter`, bỏ trống hoặc `Esc` nếu không cần). Chọn một mũi tên thì hiện **2 nút tròn** ở hai đầu: kéo một đầu thì đầu kia **đứng yên**, nên mũi tên xoay quanh nó; **giữ `Shift`** để khoá góc theo bước **15°** mà **không** đổi độ dài. Nút **Đảo chiều** lật mũi nhọn sang đầu kia — **nhãn đi theo mũi nhọn**. Ô **Nhãn** chọn đặt chữ ở đầu hay ở cuối. **Bấm đúp** để sửa nhãn.",
              "**Arrow** (`A`) — drag from tail to head. On release a **label** box opens at the arrow head (type and `Enter`; leave it empty or press `Esc` to skip). Selecting an arrow shows **two round grips**, one at each end: drag one and the other **stays put**, so the arrow pivots around it; **hold `Shift`** to lock the angle to **15°** steps **without** changing the length. **Đảo chiều** flips which end is the head — **the label follows the head**. The **Nhãn** dropdown puts the text at the head or the tail. **Double-click** to edit the label."
            ),
            T(
              "**Dấu ✓** (`K`) và **✗** (`J`) — chỉ là **ký hiệu**, không kèm ô vuông, nên tích thẳng vào checkbox có sẵn trong hợp đồng được. **Bấm một cái** ra dấu **cỡ mặc định** tại chỗ bấm (bấm sát mép trang thì dấu tự lùi vào cho nằm trọn trong trang); **kéo** để tự chọn cỡ. Mỗi loại **nhớ màu riêng** — mặc định ✓ xanh lá, ✗ đỏ — nên đổi màu ✗ không làm đổi màu bút tô sáng hay vẽ tay.",
              "**Tick ✓** (`K`) and **cross ✗** (`J`) — the **mark alone**, with no box around it, so it stamps straight into a checkbox already printed on the contract. **A single click** stamps the **default size** where you clicked (near a page edge it nudges itself inward so it lands fully on the sheet); **drag** to size it yourself. Each remembers **its own colour** — green ✓, red ✗ by default — so recolouring the cross leaves your highlighter and pen alone."
            ),
            T("**Ghi chú** (`N`) — bấm lên trang để đặt marker, gõ nội dung, `Ctrl+Enter`. Xem thêm mục **Ghi chú & bình luận**.", "**Note** (`N`) — click the page to drop a marker, type, `Ctrl+Enter`. See **Notes & comments** below."),
            T(
              "**Chèn ảnh / chữ ký** (`I`) — chọn ảnh rồi bấm lên trang để đặt. Chỉ nhận **PNG / JPG**; nên dùng **PNG nền trong** để chữ ký không có hộp trắng đè lên tài liệu. Nút **Áp nhiều trang** sao chép ảnh đang chọn sang các trang bạn nhập, **giữ nguyên vị trí và kích thước**.",
              "**Insert image / signature** (`I`) — pick an image, then click the page to place it. **PNG / JPG** only; prefer a **transparent PNG** so a signature doesn't sit in a white box over the document. **Áp nhiều trang** copies the selected image onto the pages you list, **at the same position and size**."
            ),
            T(
              "**Che thông tin — redact** (`X`) — kéo để che. Đây là che **thật**: nội dung gốc bị **xoá khỏi file** khi bấm Xong, không phải vẽ hình chữ nhật đen lên trên. Đổi **Màu che** nếu cần.",
              "**Redact** (`X`) — drag over what must go. This is a **real** redaction: the underlying content is **removed from the file** when you apply, not covered with a black rectangle. **Màu che** sets the fill colour."
            ),
            T(
              "**Đo & ghi kích thước** (`M`) — lần đầu, kéo một đoạn có kích thước **đã biết** rồi nhập số thật (kèm đơn vị và số lẻ) để **hiệu chuẩn**; từ đó các đoạn khác **tự ra số**. Ô **Tỷ lệ** trên thanh cho biết đã hiệu chuẩn hay chưa. Nút **Hiệu chuẩn lại** quên tỷ lệ hiện tại — bản vẽ khác thì tỷ lệ khác.",
              "**Measure & dimension** (`M`) — first, drag a segment whose real length you **know** and type that length (with a unit and decimal places) to **calibrate**; after that every other segment is **labelled automatically**. The **Tỷ lệ** readout on the bar tells you whether a scale is set. **Hiệu chuẩn lại** forgets the current one — a different drawing has a different scale."
            ),
            T("**Watermark** — đóng dấu mờ lên **mọi trang**: nội dung, cỡ chữ, góc, độ mờ, màu.", "**Watermark** — stamp a faint mark on **every page**: text, size, angle, opacity, colour."),
            T("**Điền form** — điền các trường biểu mẫu có sẵn trong PDF. Tick **Khóa giá trị sau khi điền (flatten)** nếu muốn giá trị không sửa được nữa.", "**Fill form** — fill the PDF's existing form fields. Tick **flatten** if the values should no longer be editable."),
          ],
        },
        {
          note: T(
            "**Màu mặc định là ĐỎ.** Hộp văn bản, mũi tên, mây, chữ nhật, tròn, bút vẽ, ghi chú và đoạn đo đều lấy màu này cho vật thể **mới** — đổi ở **Cài đặt → Màu chú thích mặc định**. Bốn thứ giữ màu riêng vì màu của chúng có nghĩa: dấu ✓ xanh (đúng), dấu ✗ đỏ (sai), **Tô sáng** vàng, **Màu che** đen. Còn ô **Màu** trên thanh công cụ chỉ ảnh hưởng vật thể đang chọn và những vật thể vẽ tiếp trong phiên này, **không** ghi vào Cài đặt.",
            "**The default colour is RED.** Text boxes, arrows, clouds, rectangles, ellipses, freehand, notes and dimensions all take it for **new** objects — change it under **Cài đặt → Màu chú thích mặc định** (Settings). Four things keep their own colour because their colour carries meaning: ✓ green (correct), ✗ red (wrong), **Tô sáng** highlighter yellow, **Màu che** black. The **Màu** picker on the toolbar only affects the selected object and what you draw next in this session — it does **not** write the setting."
          ),
        },

        { h: T("Cái gì sửa lại được sau khi Lưu?", "What stays editable after saving?") },
        {
          p: T(
            "Đây là điểm dễ mất công nhất, nên nắm trước khi bấm **Xong**:",
            "This is the easiest place to lose work, so know it before you press **Xong**:"
          ),
        },
        {
          ul: [
            T(
              "**Đối tượng sống** — **hộp văn bản, ghi chú, mũi tên, ảnh / chữ ký**, từ **v0.2.61** thêm **khoanh vùng chữ nhật, elip, khoanh mây và khoanh mây tự do**, và từ **v0.2.63** thêm **nét vẽ tay**. Mở lại file → bấm **Chú thích** → chúng lại là đối tượng riêng: chọn, kéo di chuyển, đổi màu / nét / nền, `Delete` để xoá. Hộp chữ nhật và elip kéo 4 góc đổi cỡ được; hộp văn bản, ghi chú, mũi tên và ảnh vẫn dùng được **Áp nhiều trang**.",
              "**Live objects** — **text boxes, notes, arrows, images / signatures**, from **v0.2.61** also **rectangles, ellipses, revision clouds and freehand clouds**, and from **v0.2.63** **freehand pen strokes**. Reopen the file, click **Chú thích**, and they are separate objects again: select, drag, restyle, `Delete`. Rectangles and ellipses resize by the corners; text boxes, notes, arrows and images still work with **Áp nhiều trang**."
            ),
            T(
              "**Bị dán chết** — **tô sáng, ✓ / ✗, ô che, đoạn đo**. Bấm **Xong** là chúng thành hình trên trang, **không chọn lại được**. Muốn sao chép thì **copy trước khi bấm Xong**. Từ **v0.2.69**, **dấu ✓ và ✗ copy được sang file PDF khác** giống hộp văn bản — miễn là copy khi còn đang trong **Chú thích**, trước khi bấm **Xong**. Riêng **ô che (redact)** sẽ luôn bị dán chết: nó tồn tại để **xoá hẳn** nội dung bên dưới, nên một ô che sửa lại được thì không còn là ô che nữa.",
              "**Flattened** — **highlights, ✓ / ✗, redactions, dimensions**. Once you press **Xong** they become part of the page and **cannot be selected again**. If you want to copy them, **copy before applying**. From **v0.2.69**, **✓ and ✗ marks copy into another PDF** just like text boxes — as long as you copy them while still in **Chú thích**, before pressing **Xong**. **Redactions** will always stay flattened: the tool exists to **destroy** what is underneath, and a re-editable redaction is not a redaction."
            ),
            T(
              "**Trang xoay và trang ngang cũng sửa lại được.** Trên trang có `/Rotate` — bản scan nằm ngang, bản vẽ A3, hoặc trang bạn vừa bấm **Xoay** — mọi đối tượng sống đều giữ nguyên là đối tượng sống (từ v0.2.58). File **trộn cả trang dọc lẫn trang ngang** cũng vậy: mỗi trang được tính riêng, nên **áp dụng xong không trang nào tự quay** và hình không lệch sang trang khác.",
              "**Rotated and landscape pages are editable too.** On a page with `/Rotate` — a landscape scan, an A3 drawing, or any page you had just hit **Xoay** on — live objects stay live (since v0.2.58). The same holds for files that **mix portrait and landscape pages**: every page is measured on its own, so **nothing turns after you apply** and no mark drifts onto the wrong page."
            ),
          ],
        },
        {
          note: T(
            "**Che thông tin (redact) là không thể hoàn tác sau khi Lưu.** Nội dung gốc bị xoá khỏi file — đó chính là mục đích. Nếu còn cần bản đầy đủ, hãy **Lưu thành…** một file mới và giữ bản gốc.",
            "**Redaction cannot be undone once saved.** The original content is removed from the file — that is the point. If you still need the full version, use **Lưu thành…** (Save As) for the redacted copy and keep the original."
          ),
        },
        { h: T("Phím tắt công cụ chú thích", "Annotation tool shortcuts") },
        {
          keys: [
            ["V", T("Chọn / di chuyển", "Select / move")],
            ["T", T("Hộp văn bản", "Text box")],
            ["H", T("Tô sáng", "Highlight")],
            ["D", T("Vẽ tay", "Freehand")],
            ["R", T("Khoanh vùng chữ nhật", "Rectangle")],
            ["O", T("Khoanh vùng elip / tròn", "Ellipse / circle")],
            ["C", T("Khoanh mây", "Revision cloud")],
            ["F", T("Khoanh mây tự do", "Freehand cloud")],
            ["A", T("Mũi tên", "Arrow")],
            ["K", T("Dấu ✓", "Tick ✓")],
            ["J", T("Dấu ✗", "Cross ✗")],
            ["N", T("Ghi chú", "Note")],
            ["I", T("Chèn ảnh / chữ ký", "Insert image / signature")],
            ["X", T("Che thông tin (redact)", "Redact")],
            ["M", T("Đo & ghi kích thước", "Measure & dimension")],
          ],
        },
      ],
    },

    {
      id: "textedit",
      title: T("Sửa nội dung & Tìm/Thay thế", "Editing the original text · Find & Replace"),
      blocks: [
        {
          p: T(
            "Nút **Sửa nội dung** sửa **thẳng vào chữ gốc** của PDF — khác hẳn hộp văn bản của Chú thích, thứ chỉ nằm **lên trên** trang.",
            "**Sửa nội dung** edits the PDF's **original text** — quite different from an annotation text box, which merely sits **on top of** the page."
          ),
        },
        {
          ul: [
            T(
              "✅ **PDF có chữ thật** (xuất từ Word / Excel, in ra PDF): bấm **Sửa nội dung** → các đoạn chữ hiện viền bấm được → bấm vào đoạn để sửa (kể cả tiếng Việt có dấu) → **Áp dụng** → **Lưu**. Chữ cũ bị xoá thật, chữ mới thay đúng chỗ.",
              "✅ **PDFs with real text** (exported from Word / Excel, printed to PDF): click **Sửa nội dung** → clickable outlines appear around each text run → click one to edit it → **Áp dụng** → **Lưu**. The old text is genuinely removed and the new text takes its place."
            ),
            T(
              "❌ **PDF scan** (ảnh chụp / scan giấy): không có ký tự nào để sửa. App sẽ báo và bạn nên dùng **OCR văn bản** hoặc **Bóc tách** thay thế.",
              "❌ **Scanned PDFs** (photographed / scanned paper): there are no characters to edit. The app says so; use **OCR văn bản** or **Bóc tách** instead."
            ),
            T(
              "✅ **Bản vẽ nằm ngang** (CAD / hồ sơ thầu): chữ sửa lại giữ **đúng chiều của dòng nó thay** — dòng đọc xuôi vẫn đọc xuôi, **nhãn kích thước dựng dọc vẫn dựng dọc**, nhãn dẫn viết chéo vẫn đúng góc.",
              "✅ **Landscape drawing sheets** (CAD / tender sets): a redrawn run keeps **the direction of the run it replaces** — upright text stays upright, **a vertical dimension label stays vertical**, and a slanted leader label keeps its angle."
            ),
          ],
        },
        { h: T("Trên thanh Sửa chữ gốc", "On the text-edit bar") },
        {
          ul: [
            T(
              "**Font** — **Giữ nguyên (font gốc)** là mặc định, giữ đúng font của đoạn đang sửa. Nhóm **Font máy** liệt kê font cài trên máy bạn.",
              "**Font** — **Giữ nguyên (font gốc)** is the default and keeps the run's own font. The **Font máy** group lists the fonts installed on this machine."
            ),
            T("**Cỡ**, **Chữ** (màu), **Nền** (tô sau chữ), và **B / I / U**.", "**Size**, text **colour**, a **background** fill behind the text, and **B / I / U**."),
            T(
              "**OCR ô này** — nhận dạng lại chữ của ô đang sửa bằng OCR. Dùng khi chữ gốc bị lỗi font (bảng mã `.Vn` cổ, hoặc lỗi giải mã).",
              "**OCR ô này** — re-recognise the current run with OCR. Use it when the original text is font-broken (legacy `.Vn` encodings, or a decoding fault)."
            ),
            T(
              "Số đếm trên thanh cho biết trang này có bao nhiêu đoạn chữ, và bao nhiêu đoạn bạn đã sửa nhưng **chưa ghi**. Nút **Áp dụng** chỉ sáng khi có gì để ghi.",
              "The counter on the bar shows how many text runs this page has, and how many you have edited but **not yet written**. **Áp dụng** only lights up when there is something to write."
            ),
            T("Đang sửa một đoạn: `Ctrl+Enter` ghi ngay · `Enter` tạm giữ để Áp dụng sau · `Esc` bỏ sửa đoạn đó.", "While editing a run: `Ctrl+Enter` writes it immediately · `Enter` stages it for a later Áp dụng · `Esc` abandons that edit."),
            T("Thoát khi còn đoạn chưa ghi thì app hỏi **ghi trước hay bỏ** — không mất im lặng.", "Leaving with staged edits prompts **write or discard** — nothing is lost silently."),
          ],
        },
        {
          note: T(
            "**Giới hạn đã biết:** sửa trong phạm vi **từng đoạn**, app không tự dàn lại dòng cả khối. Chữ mới dài hơn ô cũ sẽ **tự co nhỏ** cho vừa.",
            "**Known limits:** edits are **per text run**; the app does not reflow a whole paragraph. Text longer than the original run **shrinks to fit**."
          ),
        },

        { h: T("Tìm & Thay thế", "Find & Replace") },
        {
          p: T(
            "Đổi một từ khoá xuất hiện nhiều chỗ trong cả tài liệu — như `Ctrl+H` của Word. Mở bằng `Ctrl+H`, hoặc nút ⇄ ở cuối ô **Tìm trong tài liệu** trên thanh công cụ.",
            "Change a keyword that appears in many places across the whole document — like Word's `Ctrl+H`. Open it with `Ctrl+H`, or the ⇄ button at the end of the toolbar's **Tìm trong tài liệu** box."
          ),
        },
        {
          ul: [
            T(
              "Gõ chữ cần tìm rồi bấm **Tìm** (hoặc `Enter`) → app quét **toàn bộ tài liệu** và tô sáng mọi vị trí, kèm số đếm. App **không** quét theo từng ký tự bạn gõ: mỗi lần quét là một lượt đọc hết tài liệu, với tệp vài trăm trang có thể mất vài chục giây.",
              "Type what to find, then press **Tìm** (or `Enter`) → the app scans the **whole document**, highlights every match and shows a count. It does **not** scan as you type: each scan reads the entire document, which on a several-hundred-page file can take tens of seconds."
            ),
            T(
              "Sau khi đã có kết quả, `Enter` / `Shift+Enter` (hoặc nút ↑ ↓) đi tới vị trí kế / trước. Đổi từ khoá hay đổi tuỳ chọn thì kết quả cũ thành **quá hạn** — hai nút **Thay** tạm khoá cho tới khi bạn quét lại.",
              "Once you have results, `Enter` / `Shift+Enter` (or the ↑ ↓ buttons) step to the next / previous one. Changing the keyword or an option marks the old results **stale** — both **Thay** buttons stay locked until you scan again."
            ),
            T(
              "**Thay** đổi đúng vị trí đang chọn (viền cam) rồi tự nhảy sang vị trí kế — duyệt lần lượt từ trên xuống, muốn bỏ qua chỗ nào thì bấm ↓ thay vì **Thay**.",
              "**Thay** (Replace) changes just the current match — the one outlined in orange — then moves to the next, so you can walk down the document and skip any match by pressing ↓ instead."
            ),
            T(
              "**Thay tất cả** đổi mọi vị trí trong một lần. App hỏi xác nhận kèm số lượng trước khi ghi.",
              "**Thay tất cả** (Replace all) changes every match in one go. The app asks you to confirm, and tells you how many, before writing."
            ),
            T(
              "**Phân biệt hoa/thường** và **Đúng nguyên từ** hoạt động như trong Word. Bỏ trống ô **Thay bằng** thì từ khoá bị **xoá**.",
              "**Match case** and **Whole word only** behave as they do in Word. Leaving **Thay bằng** empty **deletes** the keyword."
            ),
            T(
              "`Ctrl+Z` hoàn tác cả một lần **Thay tất cả** trong một bước.",
              "`Ctrl+Z` undoes an entire **Replace all** in a single step."
            ),
            T(
              "Tài liệu **rất lớn** vẫn **tìm** được (bộ bản vẽ vài trăm trang, tới ~1GB). Riêng việc **thay** thì tài liệu trên **~200MB** chưa ghi được — app sẽ báo ngay trên dòng đếm và mờ hai nút **Thay**; dùng **Nén** để giảm dung lượng trước.",
              "**Very large documents** can still be **searched** (drawing sets of several hundred pages, up to ~1GB). **Replacing** is the part still capped: above **~200MB** the app says so on the count line and greys out both **Thay** buttons — shrink the file with **Nén** (Compress) first."
            ),
            T(
              "Lần tìm **thứ hai trở đi** trên cùng tài liệu nhanh hơn hẳn: app nhớ lại bản đồ chữ đã đọc, chỉ đọc lại khi tài liệu thay đổi.",
              "The **second and later** searches of the same document are much faster: the app keeps the text map it built and only rebuilds it when the document changes."
            ),
          ],
        },
        {
          note: T(
            "**Ba giới hạn cần biết.** (1) Chỉ chạy trên PDF có **chữ thật** — bản scan phải chạy **OCR văn bản** trước. (2) Vị trí tô **vàng nét đứt** là từ khoá bị **chia làm nhiều đoạn định dạng** (ví dụ “Bên **A**” khi chữ A in đậm): app đếm và chỉ ra cho bạn nhưng **không tự thay**, vì thay nửa vời sẽ hỏng định dạng — sửa tay bằng **Sửa nội dung**. (3) Khác với `Ctrl+F`, ô này **có phân biệt dấu**: gõ “hop dong” sẽ **không** ra “hợp đồng”. Cố ý như vậy — thay một kết quả bỏ dấu sẽ làm mất dấu trong hợp đồng của bạn.",
            "**Three limits worth knowing.** (1) It needs **real text** — run **OCR văn bản** on a scan first. (2) A match outlined in **dashed amber** is split across **two formatting runs** (\"Bên **A**\" where the A is bold): the app counts and shows it but will **not** replace it, because a half-replacement would wreck the formatting — fix those by hand with **Sửa nội dung**. (3) Unlike `Ctrl+F`, this box **is** diacritic-sensitive: typing \"hop dong\" will **not** find \"hợp đồng\". That is deliberate — replacing a diacritic-folded match would strip the accents out of your contract."
          ),
        },
      ],
    },

    {
      id: "notes",
      title: T("Ghi chú & bình luận", "Notes & comments"),
      blocks: [
        {
          p: T(
            "Nút **Ghi chú** (biểu tượng 💬 trên thanh trên cùng) mở bảng liệt kê **mọi ghi chú trong tài liệu**; bấm một dòng để nhảy tới đúng chỗ. Bảng này dùng được **ngay trong lúc đang chú thích**, và nó phản ánh cả những ghi chú chưa Lưu.",
            "The **Ghi chú** button (the 💬 icon on the top row) opens a panel listing **every note in the document**; click a row to jump to it. The panel works **while you are annotating**, and it reflects unsaved notes too."
          ),
        },
        {
          ul: [
            T("Thêm ghi chú: vào **Chú thích** → công cụ **Ghi chú** (`N`) → bấm lên trang → gõ nội dung → `Ctrl+Enter`.", "To add one: **Chú thích** → the **Ghi chú** tool (`N`) → click the page → type → `Ctrl+Enter`."),
            T(
              "**Bấm đúp** một marker 💬 để mở bảng: phần trên là nội dung gốc cùng các bình luận đã có (chỉ đọc), ô dưới để **Thêm bình luận** mà không xoá nội dung cũ. Nút **Sửa gốc** để chỉnh nội dung gốc.",
              "**Double-click** a 💬 marker to open its panel: the top shows the original text plus existing replies (read-only), the box below **adds a comment** without touching what is there. **Sửa gốc** edits the original text."
            ),
            T("Marker hiện **số bình luận**. Khi Lưu, cả chuỗi được gộp vào ghi chú của PDF nên **mọi trình xem PDF khác đọc được**.", "The marker shows the **reply count**. On save, the whole thread is written into the PDF's own annotation, so **any other PDF reader can read it**."),
          ],
        },
      ],
    },

    {
      id: "ai",
      title: T("OCR, Bóc tách & Dịch", "OCR, extraction & translation"),
      blocks: [
        { h: T("OCR văn bản (tạo lớp tìm kiếm)", "OCR text layer (searchable PDF)") },
        {
          p: T(
            "**Công cụ ▾ → OCR văn bản**: thêm một **lớp chữ vô hình** lên bản scan, để `Ctrl+F` tìm được và bôi đen / copy được chữ. Hình ảnh trang **không đổi**. Chạy **trên máy** (cần engine OCR bật); lần đầu trên máy mới thì engine tải model về.",
            "**Công cụ ▾ → OCR văn bản**: adds an **invisible text layer** to a scan so `Ctrl+F` can find it and you can select / copy the text. The page image is **unchanged**. Runs **locally** (needs the OCR engine ready); the first run on a new machine downloads the models."
          ),
        },
        { h: T("Bóc tách hợp đồng (OCR + AI)", "Contract extraction (OCR + AI)") },
        {
          p: T(
            "Nút **Bóc tách** đọc hợp đồng và rút ra các **trường dữ liệu** (số hợp đồng, ngày, bên A / bên B, giá trị…). Đây là tính năng **duy nhất** gửi nội dung tới một dịch vụ ngoài, nên nó cần **API key** của Google Gemini.",
            "**Bóc tách** reads a contract and pulls out **data fields** (contract number, dates, parties, value…). It is the **only** feature that sends content to an outside service, so it needs a Google Gemini **API key**."
          ),
        },
        {
          ul: [
            T("Bấm **⚙ Cài đặt** (hoặc badge **API**) → dán key vào ô **Gemini API key** → **Lưu**. Key được lưu an toàn trên máy này, lần sau không phải nhập lại.", "Open **⚙ Cài đặt** (or click the **API** badge) → paste the key into **Gemini API key** → **Lưu**. It is stored safely on this machine; you won't be asked again."),
            T("Chưa có key? Lấy miễn phí tại **aistudio.google.com/apikey**.", "No key yet? Get one free at **aistudio.google.com/apikey**."),
            T("Trong bảng Bóc tách: chọn **Mẫu trường** và **Phạm vi** (tất cả trang / trang đang chọn), rồi bấm **Bóc tách**. Mẫu **Trường tùy chỉnh** cho bạn tự nhập tên các trường cần lấy.", "In the extraction panel: pick a **field template** and a **scope** (all pages / selected pages), then run it. The **custom fields** template lets you name exactly the fields you want."),
            T("Kết quả **xuất ra Excel / CSV / JSON**. Mục **Văn bản OCR thô** cho xem đúng chữ mà engine đọc được, để đối chiếu khi một trường ra sai.", "Results **export to Excel / CSV / JSON**. The **raw OCR text** section shows exactly what the engine read, so you can check a field that came out wrong."),
          ],
        },
        { h: T("Dịch tài liệu (AI)", "Translate document (AI)") },
        {
          p: T(
            "**Công cụ ▾ → Dịch tài liệu**: dịch **giữ nguyên bố cục** và xuất ra một **file PDF mới**. Chỉ hỗ trợ PDF có **text thật** (không phải scan — nếu là scan thì chạy **OCR văn bản** trước). Cần Gemini API key.",
            "**Công cụ ▾ → Dịch tài liệu**: translates **keeping the layout** and writes a **new PDF**. Works only on PDFs with **real text** (not scans — run **OCR văn bản** on those first). Needs a Gemini API key."
          ),
        },
        {
          note: T(
            "Không nhập API key thì **mọi** tính năng PDF + OCR + Searchable vẫn chạy bình thường. Chỉ **Bóc tách** và **Dịch** mới cần.",
            "Without an API key, **every** PDF + OCR + searchable feature still works. Only **extraction** and **translation** need one."
          ),
        },
      ],
    },

    {
      id: "compare",
      title: T("So sánh & Chồng lớp", "Compare & overlay"),
      blocks: [
        {
          p: T(
            "**Công cụ ▾ → So sánh 2 file PDF**: chọn 2 file, app chỉ ra các trang và dòng khác nhau. Không cần mở file nào trước. PDF scan sẽ được OCR để so sánh (chậm hơn).",
            "**Công cụ ▾ → So sánh 2 file PDF**: pick two files and the app points out which pages and lines differ. Neither file needs to be open. Scans are OCR'd first to be comparable (slower)."
          ),
        },
        {
          ul: [
            T("**Tự động** — dùng text, tự OCR khi gặp bản scan. **Chỉ văn bản** — nhanh, không OCR. **Bắt buộc OCR mọi trang**.", "**Auto** — uses text, OCRs when it meets a scan. **Text only** — fast, no OCR. **Force OCR on every page**."),
            T(
              "**Bản vẽ** (CAD / Revit) — so sánh **hình ảnh**, đặt hai bản cạnh nhau và khoanh vùng thêm / xoá / sửa. Danh sách thay đổi bên trái có **ô tick từng vùng** (mặc định chọn tất): bỏ tick vùng nào thì vùng đó **mờ đi trên cả 2 bản** và **không được khoanh mây** khi xuất bản B.",
              "**Drawing** (CAD / Revit) — an **image** comparison, the two sheets side by side with added / removed / changed regions boxed. The change list on the left has a **tickbox per region** (all ticked by default): unticking one **dims it on both sheets** and leaves it **un-clouded** in the exported sheet B."
            ),
            T(
              "**Chồng lớp** — xếp 2 bản vẽ lên nhau, tự căn chỉnh và **tô màu khác biệt**: **đỏ** = chỉ có ở bản A, **xanh** = chỉ có ở bản B, **đen** = trùng nhau. Chỉnh **độ mờ** lớp trên, dùng **phím mũi tên** để căn tay từng chút, `PageUp` / `PageDown` đổi cặp trang.",
              "**Overlay** — stacks the two drawings, auto-aligns them and **colours the differences**: **red** = only in A, **blue/green** = only in B, **black** = identical. Adjust the top layer's **opacity**, nudge the alignment with the **arrow keys**, and change page pairs with `PageUp` / `PageDown`."
            ),
          ],
        },
      ],
    },

    {
      id: "export",
      title: T("Xuất & chuyển đổi", "Export & convert"),
      blocks: [
        { h: T("Xuất ▾", "Xuất ▾ (Export)") },
        {
          ul: [
            T(
              "**Xuất ra Office (Word / Excel / CSV)** — Excel / CSV giữ bảng theo đúng hàng / cột; Word giữ toàn văn kèm bảng. Chỉ hỗ trợ PDF có **text thật**; nếu là scan thì chạy **OCR văn bản** trước.",
              "**Export to Office (Word / Excel / CSV)** — Excel / CSV keep tables row-for-row and column-for-column; Word keeps the full text with its tables. Only for PDFs with **real text**; run **OCR văn bản** on a scan first."
            ),
            T("**Trang PDF → ảnh** — mỗi trang thành một ảnh, gói trong một `.zip`.", "**PDF pages → images** — one image per page, delivered as a `.zip`."),
            T(
              "**Ảnh → PDF** — chọn nhiều ảnh để gộp thành một PDF, theo đúng thứ tự chọn. Kết quả **mở ra ngay trong app** (chưa lưu, có chấm ●) nên bạn sắp xếp lại thứ tự trang, xoay, chú thích rồi mới `Ctrl+S` chọn nơi lưu.",
              "**Images → PDF** — pick several images and combine them into one PDF, in the order you selected them. The result **opens right here** (unsaved, marked ●), so you can reorder pages, rotate and annotate before pressing `Ctrl+S` to choose where it goes."
            ),
            T("**Xuất ảnh trong PDF** — lấy ra những ảnh nhúng sẵn trong tài liệu.", "**Export images in PDF** — pull out the images already embedded in the document."),
          ],
        },
        { h: T("Công cụ ▾", "Công cụ ▾ (Tools)") },
        {
          ul: [
            T("**Nén (giảm dung lượng)** — chỉ ảnh độ phân giải cao bị hạ xuống mức bạn chọn; **văn bản và vector giữ nguyên**.", "**Compress** — only high-resolution images are downsampled to the level you pick; **text and vectors are untouched**."),
            T(
              "**Nén mất bao lâu?** Hộp thoại Nén hiện dung lượng tài liệu và **ước tính thời gian** ngay khi mở, và cập nhật lại mỗi lần bạn đổi mức nén — mức **Không giảm chất lượng** nhanh hơn các mức khác rất nhiều. Thời gian phụ thuộc **dung lượng file**, gần như không phụ thuộc số trang: một bộ 600 trang chữ nén nhanh hơn hẳn một bản scan 20 trang.",
              "**How long does compressing take?** The Compress dialog shows the document size and a **time estimate** as soon as it opens, and updates it whenever you change the level — **No quality loss** is far quicker than the others. The time depends on **file size**, almost not at all on page count: a 600-page text document compresses much faster than a 20-page scan."
            ),
            T(
              "**Tài liệu rất lớn.** App nhận file tới **~1GB**, nhưng đó là giới hạn của định dạng chứ không phải của máy: lúc nén, file được giữ đồng thời ở vài nơi nên cần khoảng **gấp 4 lần dung lượng file** bộ nhớ trống. Từ khoảng **300MB** trở lên app sẽ hỏi lại trước khi chạy. Máy 8GB RAM nên dừng ở khoảng 300–400MB; máy 16GB trở lên thì thoải mái hơn. Trong lúc nén **không dừng lại được**, nhưng các thẻ khác vẫn dùng bình thường.",
              "**Very large documents.** The app accepts files up to **~1GB**, but that is the format's limit, not your machine's: while compressing, the file is held in several places at once, so you need roughly **4× the file size** in free memory. From about **300MB** up the app asks for confirmation first. On an 8GB machine, stop around 300–400MB; 16GB and above is more comfortable. Compressing **cannot be cancelled** once started, but your other tabs keep working normally."
            ),
            T(
              "**Copy ảnh trong trang** — bấm vào một ảnh để copy nó, hoặc kéo chọn một vùng bất kỳ. Rồi `Ctrl+V` dán sang app khác (Word, Excel, chat…).",
              "**Copy an image from the page** — click an image to copy it, or drag out any region. Then `Ctrl+V` into another app (Word, Excel, a chat window…)."
            ),
            T(
              "**Khoá file (đặt mật khẩu)** — đặt mật khẩu mở file. Người không có mật khẩu không xem được nội dung.",
              "**Lock file (set a password)** — set an open password. Without it, the content cannot be read."
            ),
          ],
        },
      ],
    },

    {
      id: "sign",
      title: T("Ký số (USB token)", "Digital signing (USB token)"),
      blocks: [
        {
          p: T(
            "Nút **Ký số** ký **PKI** bằng chứng thư số trên **USB token** — VNPT-CA, Viettel-CA, FPT-CA, BKAV… — đọc qua kho chứng thư của Windows, giống cách Foxit / Acrobat làm.",
            "**Ký số** applies a **PKI** signature using a certificate on a **USB token** — VNPT-CA, Viettel-CA, FPT-CA, BKAV… — read through the Windows certificate store, the same way Foxit / Acrobat do it."
          ),
        },
        {
          note: T(
            "**Đừng lẫn với \"Chèn ảnh / chữ ký\".** Cái đó chỉ là **hình ảnh** trên trang: không có giá trị pháp lý, ai cũng xoá / sửa được. **Ký số** là **niêm phong mã hoá** — người nhận mở bằng Foxit / Acrobat sẽ thấy chữ ký được xác thực và biết file có bị sửa sau khi ký hay không. Dùng chung được: chèn ảnh con dấu cho đẹp, rồi ký số để có hiệu lực.",
            "**Don't confuse this with \"Insert image / signature\".** That is just a **picture** on the page: no legal weight, and anyone can move or delete it. **Ký số** is a **cryptographic seal** — a recipient opening the file in Foxit / Acrobat sees a verified signature and whether the file was altered after signing. They combine well: paste the stamp image for looks, then sign for validity."
          ),
        },
        {
          ul: [
            T("**Cắm token trước khi ký**, rồi bấm **Ký số**. Ô **Chứng thư số** tự liệt kê chứng thư tìm được — cắm muộn thì bấm **Làm mới** để quét lại.", "**Plug the token in first**, then click **Ký số**. The certificate list fills itself in — if you plugged in late, press **Làm mới** to rescan."),
            T("Điền **Lý do ký** / **Nơi ký** nếu cần, và chọn **Ảnh chữ ký / con dấu** (tuỳ chọn) để chữ ký nhìn thấy có hình.", "Fill in **reason** / **location** if you want them, and optionally pick a **signature / stamp image** so the visible signature carries a graphic."),
            T(
              "**Dấu thời gian (TSA)** — tuỳ chọn. Dán URL dịch vụ TSA của nhà cung cấp chữ ký số của bạn; nó chứng minh **thời điểm** ký nên tăng giá trị pháp lý. Đây là ô **duy nhất** trong luồng ký cần mạng — để trống thì ký hoàn toàn offline.",
              "**Timestamp (TSA)** — optional. Paste your CA's TSA URL; it proves **when** you signed, which strengthens the signature legally. This is the **only** part of signing that needs the internet — leave it blank and signing is fully offline."
            ),
            T("Bấm **Tiếp: kéo khung trên trang** → kéo một khung ở chỗ muốn hiện chữ ký. Bỏ tick **Hiển thị chữ ký trên trang** nếu chỉ cần ký ngầm.", "Click **next: drag a box on the page** → drag where the signature should appear. Untick **show the signature on the page** for an invisible signature."),
            T("**Token tự hỏi mã PIN của nó.** Nabu không bao giờ thấy mã PIN, và **khoá bí mật không rời token**. Xong, app hỏi nơi lưu và ghi ra một **file MỚI**.", "**The token asks for its own PIN.** Nabu never sees it, and **the private key never leaves the token**. When done, the app asks where to save and writes a **new file**."),
          ],
        },
        {
          note: T(
            "🔴 **Ký số là bước CUỐI CÙNG.** Ký xong mà còn chỉnh sửa rồi lưu đè lên file đã ký thì **chữ ký mất hiệu lực** — chữ ký niêm phong đúng chuỗi byte tại thời điểm ký, đổi một byte là niêm phong vỡ. Vậy nên làm xong mọi việc (chú thích, sửa chữ, ghép / tách trang, đóng dấu ảnh, đánh số trang…) **trước**, ký sau cùng. Cần sửa thì sửa trên **bản chưa ký** rồi ký lại.",
            "🔴 **Signing is the LAST step.** Edit a signed file and save over it and **the signature is void** — it seals the exact bytes at the moment of signing, and changing one byte breaks the seal. So finish everything else (annotations, text edits, merging / splitting, stamps, page numbers…) **first**, and sign last. If you must change something, change the **unsigned** copy and sign again."
          ),
        },
      ],
    },

    {
      id: "print",
      title: T("In", "Printing"),
      blocks: [
        {
          p: T(
            "`Ctrl+P` mở hộp thoại In của Nabu. **Nên chọn trang ngay ở đây** thay vì mở hộp thoại của hệ thống.",
            "`Ctrl+P` opens Nabu's own print dialog. **Choose your pages here** rather than in the system dialog."
          ),
        },
        {
          ul: [
            T(
              "Ô **Trang cần in**: gõ `1-2`, hoặc `1-3, 5, 8-10`. **Để trống là in tất cả.** Dòng ngay dưới ô luôn cho xem trước **sẽ in mấy trang, những trang nào** trước khi bạn bấm, và nút **In** tự khoá nếu không nhận ra trang nào.",
              "The **pages** box: type `1-2`, or `1-3, 5, 8-10`. **Leave it empty to print everything.** The line under the box always previews **how many pages and which ones** before you commit, and **In** disables itself if nothing parses."
            ),
            T(
              "Khoảng trang trong hộp thoại của **Windows** đếm theo **TỜ giấy in ra**; ô của **Nabu** đếm theo **trang tài liệu**. Với tài liệu thường thì hai cách ra cùng kết quả, nhưng ô của Nabu luôn đúng ý bạn hơn.",
              "A range typed in the **Windows** dialog counts printed **sheets**; Nabu's box counts **document pages**. For ordinary documents both give the same result, but Nabu's box always means what you meant."
            ),
            T(
              "**Mỗi trang tài liệu luôn in gọn trong đúng một tờ giấy**, ở mọi khổ (A4 → A0, Letter, Legal) và giữ nguyên tỷ lệ — không bị đẩy phần dưới sang tờ sau, không bị cắt, không bị kéo méo. Khổ giấy có tỷ lệ khác trang tài liệu thì phần chênh là **dải trắng** ở hai mép.",
              "**One document page always fits on exactly one sheet**, at any paper size (A4 → A0, Letter, Legal) and at true scale — never pushed onto a second sheet, never cropped, never stretched. Where the paper's proportions differ from the page's, the difference shows as **white margins**."
            ),
            T(
              "Tài liệu có **cả trang dọc và trang ngang** vẫn in đúng, mỗi trang một tờ. Trang ngang nằm gọn giữa tờ giấy dọc (nên nhỏ hơn); muốn nó lấp trọn tờ thì chọn **Hướng giấy → Ngang** cho các trang đó, hoặc tách chúng ra in riêng.",
              "A document mixing **portrait and landscape** pages still prints correctly, one page per sheet. A landscape page sits centred on a portrait sheet (so it is smaller); to fill the sheet, set **orientation → landscape** for those pages, or extract them and print separately."
            ),
            T("Máy in không hỗ trợ **2 mặt** thì tự in 1 mặt.", "Printers without **duplex** support simply print single-sided."),
          ],
        },
      ],
    },

    {
      id: "keys",
      title: T("Phím tắt", "Keyboard shortcuts"),
      blocks: [
        { h: T("Tập tin", "File") },
        {
          keys: [
            ["Ctrl+O", T("Mở tài liệu", "Open a document")],
            ["Ctrl+S", T("Lưu (ghi đè file đang mở)", "Save (overwrite the open file)")],
            ["Ctrl+Shift+S", T("Lưu thành… file mới", "Save As… a new file")],
            ["Ctrl+P", T("In", "Print")],
            ["Ctrl+T", T("Tab mới", "New tab")],
            ["Ctrl+W", T("Đóng tab", "Close tab")],
            ["Ctrl+N", T("Cửa sổ mới", "New window")],
            ["Ctrl+Shift+W", T("Đóng cửa sổ", "Close window")],
          ],
        },
        { h: T("Chỉnh sửa & xem", "Edit & view") },
        {
          keys: [
            ["Ctrl+Z", T("Hoàn tác (trong Chú thích: hoàn tác từng bước chú thích)", "Undo (inside Chú thích: undo one annotation step)")],
            ["Ctrl+Y", T("Làm lại", "Redo")],
            ["Ctrl+F", T("Tìm trong tài liệu", "Find in document")],
            ["Ctrl+H", T("Tìm & Thay thế chữ trong PDF", "Find & replace text in the PDF")],
            ["Enter / Shift+Enter", T("Kết quả tìm kế / trước", "Next / previous match")],
            ["Ctrl + / Ctrl −", T("Phóng to / thu nhỏ", "Zoom in / out")],
            ["Ctrl 0", T("Cỡ gốc 100%", "Actual size (100%)")],
            [T("Ctrl + lăn chuột", "Ctrl + wheel"), T("Phóng to bám theo con trỏ", "Zoom around the pointer")],
            ["F4", T("Ẩn / hiện cột trang", "Hide / show the page list")],
            ["F11", T("Toàn màn hình (Esc để thoát)", "Full screen (Esc exits)")],
            ["Ctrl+\\", T("Chia đôi màn hình (bật / tắt khung xem chỉ đọc)", "Split view (toggle the read-only pane)")],
            ["Ctrl+Shift+\\", T("Thêm một khung xem nữa (tối đa 3 khung)", "Add another view pane (three panes max)")],
            ["Esc", T("Đóng hộp thoại đang mở (như bấm Hủy)", "Close the open dialog (same as Hủy)")],
            ["↑ / ↓ · PageUp / PageDown", T("Trang trước / trang kế", "Previous / next page")],
            ["Delete", T("Xoá trang đang chọn", "Delete the selected pages")],
            ["H / V", T("Bàn tay / chọn chữ (khi đang xem trang)", "Hand / select text (in the page view)")],
            [T("Space (giữ)", "Space (hold)"), T("Dùng bàn tay tạm thời", "Borrow the hand tool")],
            ["F1", T("Mở trang Hướng dẫn này", "Open this guide")],
          ],
        },
        {
          p: T(
            "Phím tắt riêng của **Chú thích** nằm ở cuối mục **Chú thích & đánh dấu**.",
            "The shortcuts specific to **annotating** are at the end of the **Annotating & markup** section."
          ),
        },
      ],
    },

    {
      id: "offline",
      title: T("Offline, bảo mật & sự cố", "Offline, privacy & troubleshooting"),
      blocks: [
        { h: T("Tính năng nào cần mạng?", "What needs the internet?") },
        {
          table: {
            head: [T("Nhóm tính năng", "Feature group"), T("Cần mạng?", "Internet?"), T("Ghi chú", "Notes")],
            rows: [
              [
                T("Xem · ghép · tách · chèn · xoay · xoá · sắp xếp · **Lưu**", "View · merge · split · insert · rotate · delete · reorder · **save**"),
                T("Không", "No"),
                T("Hoàn toàn offline, không cần engine OCR.", "Fully offline, no OCR engine needed."),
              ],
              [
                T("**Chú thích** · watermark · redact · điền form", "**Annotate** · watermark · redact · fill forms"),
                T("Không", "No"),
                T("Offline.", "Offline."),
              ],
              [
                T("**Sửa nội dung** · **Nén** · **Khoá file** · xuất ảnh · PDF ↔ ảnh", "**Text editing** · **compress** · **lock file** · image export · PDF ↔ images"),
                T("Không", "No"),
                T("Offline, dùng thư viện PDF gói sẵn.", "Offline, using the bundled PDF libraries."),
              ],
              [
                T("**Ký số** bằng USB token", "**Digital signing** with a USB token"),
                T("Chỉ TSA", "TSA only"),
                T("Việc ký chạy offline. Chỉ **dấu thời gian (TSA)** cần mạng — để trống ô đó là offline hoàn toàn.", "Signing itself is offline. Only the **timestamp (TSA)** needs a connection — leave it blank and it is fully offline."),
              ],
              [
                T("**So sánh** · **Chồng lớp** bản vẽ", "**Compare** · drawing **overlay**"),
                T("Cần engine", "Engine needed"),
                T("Cần badge OCR sẵn sàng. Bản vẽ chạy offline; PDF scan cần model OCR.", "Needs the OCR badge ready. Drawings run offline; scans need the OCR models."),
              ],
              [
                T("**OCR văn bản** (lớp tìm kiếm)", "**OCR text layer** (searchable)"),
                T("Lần đầu", "First run"),
                T("Cần engine OCR; lần đầu trên máy mới thì tải model.", "Needs the OCR engine; the first run on a new machine downloads models."),
              ],
              [
                T("**Bóc tách** hợp đồng · **Dịch tài liệu**", "**Contract extraction** · **translation**"),
                T("Có", "Yes"),
                T("Cần model OCR **và** API key AI. Đây là hai tính năng duy nhất gửi nội dung ra ngoài.", "Needs OCR models **and** an AI key. These are the only two features that send content outside."),
              ],
            ],
          },
        },
        { h: T("Sự cố thường gặp", "Common problems") },
        {
          table: {
            head: [T("Hiện tượng", "Symptom"), T("Cách xử lý", "What to do")],
            rows: [
              [
                T("Badge kẹt ở \"OCR: …\", mãi không sẵn sàng", "The badge stays at \"OCR: …\" and never becomes ready"),
                T("Lần đầu đang tải model (cần mạng) — chờ. Sau vài phút vẫn lỗi thì kiểm tra mạng.", "It is downloading models on first use (needs the internet) — wait. If it still fails after a few minutes, check the connection."),
              ],
              [
                T("\"OCR: lỗi\"", "\"OCR: error\""),
                T("Thường do lần đầu không có mạng để tải model, hoặc thiếu RAM. Nối mạng rồi mở lại app.", "Usually no internet on the first run to fetch the models, or not enough RAM. Connect and restart the app."),
              ],
              [
                T("Bóc tách báo thiếu key", "Extraction says the key is missing"),
                T("Bấm **⚙ Cài đặt** → dán Gemini API key → **Lưu**.", "Open **⚙ Cài đặt** → paste the Gemini API key → **Lưu**."),
              ],
              [
                T("Sửa nội dung báo \"trang này là ảnh scan\"", "Text editing says the page is a scan"),
                T("Trang không có ký tự nào để sửa. Dùng **OCR văn bản** hoặc **Bóc tách**.", "There are no characters to edit. Use **OCR văn bản** or **Bóc tách**."),
              ],
              [
                T("App mở chậm lần đầu", "The app is slow to start the first time"),
                T("Bình thường — engine OCR tải ngầm ở lần dùng đầu. Lần sau nhanh hơn.", "Normal — the OCR engine loads in the background on first use. Later launches are faster."),
              ],
              [
                T("Máy yếu, OCR chậm", "OCR is slow on a modest machine"),
                T("Engine chạy trên CPU nên PDF nhiều trang sẽ lâu. Các thao tác PDF thường (xem / ghép / sửa chữ) vẫn nhanh.", "The engine runs on the CPU, so long PDFs take a while. Ordinary PDF work (viewing / merging / text editing) stays fast."),
              ],
            ],
          },
        },
        {
          note: T(
            "**Cập nhật:** **Cài đặt → Kiểm tra cập nhật**. **Giao diện** (Tối / Sáng) và **Ngôn ngữ** (Tiếng Việt / English) cũng ở đó — đổi ngôn ngữ thì cả thanh menu của hệ điều hành và trang hướng dẫn này đổi theo.",
            "**Updates:** **Cài đặt → Kiểm tra cập nhật**. The **theme** (dark / light) and **language** (Vietnamese / English) live there too — switching language changes the native menu bar and this guide along with it."
          ),
        },
      ],
    },
  ];

  // ---- rendering ------------------------------------------------------------

  let built = false;

  // `typeof window` guard, not a bare `window.I18N`: this module is also loaded under
  // Node by the test grid, where `window` does not exist at all.
  const lang = () =>
    typeof window !== "undefined" && window.I18N && window.I18N.getLang() === "en" ? "en" : "vi";
  // Pick the current language out of a { vi, en } pair, falling back to Vietnamese —
  // the same "missing translation shows the source" rule i18n.js uses.
  const L = (v) => (v && typeof v === "object" ? v[lang()] || v.vi : v || "");

  // Escape FIRST, then apply the two inline markers. Doing it the other way round would
  // escape our own generated tags. The content is ours, but escaping is what keeps a
  // stray `<` in a future guide entry from silently becoming markup.
  function fmt(v) {
    const esc = L(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  // Paragraph text may carry "\n" to break lines inside one block (used by the longer
  // callouts, where two related rules read better stacked than as separate boxes).
  function para(v, cls) {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.innerHTML = fmt(v).replace(/\n/g, "<br />");
    return p;
  }

  function renderBlock(b) {
    if (b.h) {
      const h = document.createElement("h4");
      h.className = "help-h";
      h.innerHTML = fmt(b.h);
      return h;
    }
    if (b.p) return para(b.p);
    if (b.note) return para(b.note, "help-note");
    if (b.ul) {
      const ul = document.createElement("ul");
      ul.className = "help-ul";
      for (const item of b.ul) {
        const li = document.createElement("li");
        li.innerHTML = fmt(item).replace(/\n/g, "<br />");
        ul.appendChild(li);
      }
      return ul;
    }
    if (b.keys) {
      const tbl = document.createElement("table");
      tbl.className = "help-table help-keys";
      const body = document.createElement("tbody");
      for (const [k, meaning] of b.keys) {
        const tr = document.createElement("tr");
        const kd = document.createElement("td");
        const kbd = document.createElement("kbd");
        // Most key names are language-neutral plain strings; the few that carry a word
        // ("Ctrl + lăn chuột", "Space (giữ)") come through as a { vi, en } pair.
        kbd.textContent = typeof k === "string" ? k : L(k);
        kd.appendChild(kbd);
        const md = document.createElement("td");
        md.innerHTML = fmt(meaning);
        tr.append(kd, md);
        body.appendChild(tr);
      }
      tbl.appendChild(body);
      return tbl;
    }
    if (b.table) {
      const tbl = document.createElement("table");
      tbl.className = "help-table";
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const h of b.table.head) {
        const th = document.createElement("th");
        th.innerHTML = fmt(h);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      const body = document.createElement("tbody");
      for (const row of b.table.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          td.innerHTML = fmt(cell);
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      tbl.append(thead, body);
      return tbl;
    }
    return document.createTextNode("");
  }

  function render() {
    const toc = byId("help-toc");
    const doc = byId("help-doc");
    if (!toc || !doc) return;
    toc.textContent = "";
    doc.textContent = "";

    byId("help-title").textContent = L(UI.title);
    byId("help-close").textContent = L(UI.close);
    const search = byId("help-search");
    if (search) search.placeholder = L(UI.search);

    SECTIONS.forEach((sec, i) => {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "help-toc-item" + (i === 0 ? " active" : "");
      link.dataset.target = sec.id;
      link.textContent = `${i + 1}. ${L(sec.title)}`;
      toc.appendChild(link);

      const wrap = document.createElement("section");
      wrap.className = "help-sec";
      wrap.id = "help-sec-" + sec.id;
      wrap.dataset.sec = sec.id; // paired with the TOC item's data-target by applyFilter
      const h = document.createElement("h3");
      h.textContent = `${i + 1}. ${L(sec.title)}`;
      wrap.appendChild(h);
      for (const b of sec.blocks) wrap.appendChild(renderBlock(b));
      doc.appendChild(wrap);
    });

    const none = document.createElement("p");
    none.className = "help-empty";
    none.id = "help-empty";
    none.hidden = true;
    none.textContent = L(UI.empty);
    doc.appendChild(none);
  }

  // ---- search ---------------------------------------------------------------

  // Combining marks left behind by NFD. Built from a string so the source stays ASCII —
  // a literal class of bare combining characters is unreadable and does not survive
  // copy/paste between editors intact.
  const COMBINING = new RegExp("[\\u0300-\\u036f]", "g");

  // Fold diacritics so a Vietnamese typist who skips them still matches: "mui ten"
  // finds "mũi tên". NFD splits the accents off; `đ` has no decomposition, so it needs
  // its own pass.
  function fold(s) {
    return String(s).toLowerCase().replace(/đ/g, "d").normalize("NFD").replace(COMBINING, "");
  }

  function applyFilter(qRaw) {
    const q = fold(qRaw.trim());
    const secs = [...document.querySelectorAll("#help-doc .help-sec")];
    let shown = 0;
    for (const sec of secs) {
      // Folded text is cached on the node at render time: without it every keystroke
      // would re-fold the whole guide (tens of KB) once per section.
      if (sec.dataset.fold == null) sec.dataset.fold = fold(sec.textContent);
      const hit = !q || sec.dataset.fold.includes(q);
      sec.hidden = !hit;
      if (hit) shown++;
      const link = document.querySelector(`#help-toc [data-target="${sec.dataset.sec}"]`);
      if (link) link.hidden = !hit;
    }
    const none = byId("help-empty");
    if (none) none.hidden = shown > 0;
  }

  // ---- open / close ---------------------------------------------------------

  function open() {
    const modal = byId("help-modal");
    if (!modal) return;
    if (!built) {
      render();
      built = true;
    }
    modal.hidden = false;
    const search = byId("help-search");
    if (search) {
      search.value = "";
      applyFilter("");
    }
    const doc = byId("help-doc");
    if (doc) doc.scrollTop = 0;
    // Focus the scroller, not the search box: PageUp/PageDown and the arrow keys should
    // read the guide straight away, and a caret sitting in a search field is also what
    // keeps app.js's isTyping() true for keys the user may still want (Esc closes here).
    if (doc) doc.focus();
  }

  function close() {
    const modal = byId("help-modal");
    if (modal) modal.hidden = true;
  }

  // ---- wiring ---------------------------------------------------------------

  function wire() {
    const closeBtn = byId("help-close");
    if (closeBtn) closeBtn.onclick = close;
    const btn = byId("btn-help");
    if (btn) btn.onclick = open;

    const search = byId("help-search");
    if (search) {
      search.addEventListener("input", () => applyFilter(search.value));
      // Esc inside the box clears the filter first, and only closes on a second press —
      // otherwise a typo means starting the whole lookup over.
      search.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (search.value) {
          search.value = "";
          applyFilter("");
        } else {
          close();
        }
      });
    }

    const toc = byId("help-toc");
    if (toc) {
      toc.addEventListener("click", (e) => {
        const item = e.target.closest(".help-toc-item");
        if (!item) return;
        toc.querySelectorAll(".help-toc-item").forEach((x) => x.classList.toggle("active", x === item));
        const sec = byId("help-sec-" + item.dataset.target);
        if (sec) sec.scrollIntoView({ block: "start" });
      });
    }

    // Backdrop click closes; a click inside the card must not.
    const modal = byId("help-modal");
    if (modal) {
      modal.addEventListener("mousedown", (e) => {
        if (e.target === modal) close();
      });
    }

    // Esc anywhere while the guide is up. Only acts when THIS modal is the visible one,
    // so it can never steal Esc from a dialog opened on top of it.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const m = byId("help-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      close();
    });

    // Language switch: rebuild in place, but only if the guide was ever opened.
    window.addEventListener("i18n:changed", () => {
      if (!built) return;
      const q = byId("help-search") ? byId("help-search").value : "";
      render();
      applyFilter(q);
    });
  }

  // In the renderer: bootstrap and publish window.Help. Under Node (`npm run test:help`)
  // there is no DOM, so skip the wiring and hand the content table to CommonJS instead —
  // the same dual shape page-range.js / annot-geom.js use, and what lets the test grid
  // assert VI/EN parity on every string without an Electron probe.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", wire);
    } else {
      wire();
    }
  }
  if (typeof window !== "undefined") window.Help = { open, close };
  if (typeof module !== "undefined" && module.exports) module.exports = { SECTIONS, UI, fold, fmt, T };
})();
