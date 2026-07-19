# Tesla 庫存監控 — 遷移到 Google Cloud 免費 VM + Docker 計畫

> 這份文件是寫給接手執行的人／模型看的，假設對方沒有讀過先前的對話記錄，所有必要背景都寫在這裡。

## 目標

把現在跑在使用者本機 Windows（Task Scheduler 每 10 分鐘一次）的 Tesla 商品庫存監控腳本，搬到 Google Cloud 的免費方案 VM 上、用 Docker 跑，讓監控不依賴使用者的電腦是否開機登入。

## 背景（必讀，否則會重工或做錯方向）

### 監控目標
- 商品：Tesla GEN II Mobile Connector Bundle (JP)
- 商品頁：https://shop.tesla.com/ja_jp/product/gen-2-mobile-connector-bundle-jp
- SKU：`1458882-00-D`
- 真正的庫存 API：`POST https://shop.tesla.com/ja_jp/inventory.json`，body 是 `["1458882-00-D"]`，回應像 `[{"purchasable":false,"skuCode":"1458882-00-D","error":"Out of stock","inventoryCount":0}]`
- 判斷邏輯：`purchasable === true` 或 `inventoryCount > 0` → 有庫存；`purchasable === false` 或 `error === "Out of stock"` → 缺貨；其他情況一律當作 `unknown`（判斷不能，絕對不可誤判為有庫存）
- 通知：狀態從「缺貨」轉為「有庫存」時，透過 Telegram Bot 推播給使用者（token 存在 `C:\Users\cky19\.claude\channels\telegram\.env` 的 `TELEGRAM_BOT_TOKEN`，chat_id 固定 `5964743393`）。**只在狀態轉變時發送一次，不要每次檢查都發。**

### 現有程式碼（已驗證可用，是移植的基礎）
GitHub repo：https://github.com/ChunkangYang/tesla-stock-monitor（public）
本機路徑：`C:\Users\cky19\Documents\workspace\playground\tesla-stock-monitor\`

核心檔案：
- `monitor.js` — 主邏輯（CDP attach → 打庫存 API → 判斷 → 通知）
- `chrome-launcher.js` — 確保有一個帶 remote-debugging-port 的持久 Chrome 在跑，沒有就啟動一個
- `state.json` — 記錄 `{"lastStatus": "out_of_stock"}`，用來判斷是否為「狀態轉變」
- `.chrome-profile/`（gitignore 排除）— Chrome 的專用 profile 目錄，存放 Akamai 的信任 cookies，**這個目錄的持久性是整套技術能不能運作的關鍵**

### 為什麼不能簡單地整頁爬蟲或用 headless
Tesla 商店有 Akamai Bot Manager 防護，已經實測確認：
1. **Headless 瀏覽器一律被擋**（403 Access Denied），不管怎麼加反偵測參數都一樣，這是 Chrome 本身的 headless 旗標被偵測到，不是 fingerprint 問題
2. **短時間內密集請求會觸發速率封鎖**（已實測：短時間內打 7-8 次就被冷凍超過 30 分鐘），所以檢查頻率不能太高，目前用 10 分鐘一次
3. **每次都重開全新瀏覽器等於每次都是「陌生訪客」**，比較容易被判定可疑

### 目前驗證有效的技術方案
不整頁爬 DOM 文字，改成：
1. 啟動一個「真實、有頭（非 headless）」的 Chrome，帶 `--remote-debugging-port=9222` 和專屬 `--user-data-dir`（不是使用者平常用的 Chrome profile，是監控專用的獨立 profile）
2. **這個 Chrome 進程要保持常駐**，不要每次檢查都關掉重開——每次重開就等於信任分數歸零重來
3. 每次檢查時，用 Playwright 的 `chromium.connectOverCDP('http://localhost:9222')` 連上這個已經在跑的 Chrome（不是 `chromium.launch()` 開新的）
4. 先導航到防護較鬆的商店首頁 `https://shop.tesla.com/ja_jp/`「暖身」，建立 Akamai 的 `_abck` session cookie
5. 用 `page.evaluate()` 在該頁面的 JS context 裡執行 `fetch(inventoryApiUrl, {credentials:'include', ...})`，直接打庫存 API，不用整頁 reload
6. 拿到 JSON 回應後判斷庫存狀態

這套技術是參考了一個第三方開源專案（`kdragon1988/tesla-charger-getter`，已完整讀過原始碼確認無惡意行為）之後移植過來的，**已經在本機真實驗證有效**：同一個家用 IP 才剛被舊的整頁爬蟲方法擋下沒多久，換這套新技術立刻就拿到真實 API 回應。

### 雲端部署已知會踩到的坑（GitHub Actions 的失敗經驗，非常重要）
我們先前試過把同樣的監控邏輯搬到 GitHub Actions（用 Xvfb 虛擬螢幕跑有頭 Chrome），**結果是：不管有頭無頭、跑了兩次都被擋（Access Denied），且是資料中心 IP 本身就不被信任的問題，不是瀏覽器偽裝技巧的問題**。

關鍵診斷依據：
- 回應是 HTTP 200 但 body 是 Access Denied 頁面，這是 Akamai edge/IP 層級的封鎖特徵，不是瀏覽器 fingerprint 挑戰頁
- 而且 GitHub Actions 的每次執行都是全新、用完即丟的虛擬機，**完全無法累積 session 信任**，這是跟 GCP 常駐 VM 最大的不同點

**GCP 的 VM IP 一樣屬於資料中心 IP 段，理論上有一樣被 Akamai 不信任的風險。差別在於：GCP VM 是常駐機器，可以套用上面那套「持久 Chrome + CDP attach」技術，讓同一個瀏覽器 session 長時間存在、逐漸累積行為信任分數 —— 這有機會、但不保證能克服 IP 本身的不信任。這件事沒有實際部署測試過，不能保證會成功。**

## 明確的禁區（不可以做的事）

1. **不要用住宅代理服務（residential proxy）偽裝 GCP 的 IP。** 商品頁面上寫著「同一帳號限購一件，到 2026/7/31」，代表 Tesla 本來就在防搶購機器人。如果 GCP 直連被擋，正確答案是回退到本機方案，而不是升級成主動繞過對方刻意設下的反機器人措施。
2. **不要為了「試試看能不能過」而拉高檢查頻率。** 已經實測過高頻會觸發封鎖，維持 10 分鐘一次。
3. **不要把 Telegram bot token 寫進 Docker image 或 commit 進 git repo。** 一律用環境變數／Docker secrets／`--env-file` 傳入。
4. **在雲端版本驗證成功、穩定運作一段時間之前，不要關掉本機的 Windows Task Scheduler 監控。** 本機方案目前是唯一已驗證持續有效的版本，是 fallback。
5. **本機和雲端不要同時上線發通知。** 兩邊都在跑會導致同一次庫存變化收到兩則重複通知（或更糟，兩邊 state.json 不同步導致邏輯錯亂）。決定好由哪一邊負責通知，另一邊關閉通知或直接停用。

## 執行前必須向使用者確認的問題

在動手之前，請先問清楚以下幾點，不要自己假設：

1. **使用者是否已經有已綁信用卡的 Google Cloud 帳號？**
   GCP 即使是 Always Free 額度也需要綁信用卡才能建立 VM，這一步無法代使用者完成，需要使用者自己去 https://cloud.google.com/free 完成註冊。如果還沒有，先停在這裡，請使用者完成註冊後再繼續。

2. **要用哪個免費區域？**
   GCP Always Free 的 e2-micro 執行個體只在這三個美國區域免費：`us-west1`（Oregon）、`us-central1`（Iowa）、`us-east1`（South Carolina）。**沒有日本區域可選。** 建議預設用 `us-west1`，但要讓使用者知道：從美國 IP 去存取一個日文（ja_jp）商店頁面，本身可能是額外的可疑訊號（正常訪客大多是日本流量），這是除了「資料中心 IP」之外的第二層風險，請一併告知。

3. **VM 建立方式：本機裝 gcloud CLI 全自動化，還是使用者自己在 GCP Console 網頁介面手動建立？**
   兩種都可行。如果使用者不想在本機裝更多工具，可以走網頁 Console 建立，之後用瀏覽器內建的 SSH 按鈕操作，把指令和輸出貼來貼去溝通。

4. **VM 建好之後怎麼交接存取權？**
   拿到 VM 外部 IP 之後，是要設定 SSH key 讓自動化流程直接連進去操作，還是使用者自己開瀏覽器 SSH 主控台、由你口頭/文字轉達指令和回傳結果？

5. **如果 Phase 4 驗證發現 GCP 的 IP 一樣被 Akamai 擋，要怎麼辦？**
   選項：(a) 回退繼續用本機方案，接受「這個商品只能本機監控」的事實；(b) 嘗試別家雲端服務商（但要先說清楚：大部分主流雲端 IP 都面臨同樣的資料中心信任問題，換家可能還是一樣不通）；(c) 放棄雲端化。**不要自己選，先問使用者要選哪個。**

## 執行步驟

### Phase 0：帳號與 VM 建立（使用者本人操作，無法代勞）
1. 使用者到 https://console.cloud.google.com 建立/登入帳號並綁信用卡（不會被扣款，只要留在 Always Free 額度內）
2. 建立新專案（例如命名 `tesla-stock-monitor`）
3. 啟用 Compute Engine API
4. 建立 e2-micro VM：
   - 區域：`us-west1`（或依上面問題 2 的回答調整）
   - 機型：`e2-micro`
   - 開機磁碟：Debian 12 或 Ubuntu 22.04 LTS，標準持久磁碟，容量 ≤30GB（維持免費額度內）
   - 防火牆：預設允許 SSH（22 port）即可，不需要對外開 HTTP/HTTPS，因為這個服務不接受外部連線
5. 依問題 3、4 的回答取得存取方式（gcloud CLI 或瀏覽器 SSH）

### Phase 1：VM 上安裝 Docker
```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker $USER   # 之後需要重新登入 SSH 才生效
docker --version                 # 驗證安裝成功
```

### Phase 2：把現有程式碼包成 Docker container

需要對現有程式碼做的修改（現在是 Windows 專用，要改成跨平台或直接 Linux 專用）：

**`chrome-launcher.js` 要改的地方：**
- `CHROME_EXE` 目前寫死 Windows 路徑 `C:\Program Files\Google\Chrome\Application\chrome.exe`，Linux container 裡要改成 `/usr/bin/google-chrome-stable`
- `--window-position=-2400,-2400` 這個「移到螢幕外」的技巧在 Xvfb 虛擬螢幕下沒有意義（反正沒人在看），可以拿掉，留著也無害

**執行方式要改：**
- 原本本機是 Windows Task Scheduler 每 10 分鐘啟動一次全新的 `node monitor.js` 進程，但**這次 Chrome 進程本身要保持常駐**（靠 `chrome-launcher.js` 的「已經在跑就不重啟」邏輯做到）
- Docker container 裡建議用一個無窮迴圈當作 `CMD`，讓「同一個 container」持續存活、裡面的 Chrome 進程也持續存活，只有 `node monitor.js` 這個檢查動作每 10 分鐘跑一次：
  ```dockerfile
  CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 & export DISPLAY=:99 && while true; do node monitor.js; sleep 600; done"]
  ```
  **不要**用「每 10 分鐘啟動一個新 container」的方式（例如靠 cron 或 Cloud Scheduler 重建 container），那樣會導致 Chrome 每次都要重開，等於喪失整套技術的核心優勢（session 持久性）。

**Dockerfile 草稿：**
```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y wget gnupg xvfb \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 & export DISPLAY=:99 && while true; do node monitor.js; sleep 600; done"]
```

**Telegram 密鑰處理：** 不寫進 image，用環境變數傳入（見 Phase 3 的 `docker run` 指令）。`monitor.js` 裡已經有讀 `process.env.TELEGRAM_BOT_TOKEN` 和 `process.env.TELEGRAM_CHAT_ID` 的邏輯（原本是為了 GitHub Actions Secrets 寫的），可以直接沿用。

**持久化：** 用 Docker volume 掛載兩個目錄，讓 container 重建時不會遺失：
- `.chrome-profile/`（Akamai 信任 cookies，**最重要，遺失等於信任歸零重來**）
- `state.json` 所在的目錄（避免重複通知）

### Phase 3：部署啟動
```bash
git clone https://github.com/ChunkangYang/tesla-stock-monitor.git
cd tesla-stock-monitor
# 套用 Phase 2 的程式碼修改後：
docker build -t tesla-stock-monitor .
docker run -d \
  --name tesla-monitor \
  --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN="<從 C:\Users\cky19\.claude\channels\telegram\.env 複製>" \
  -e TELEGRAM_CHAT_ID="5964743393" \
  -v tesla-monitor-profile:/app/.chrome-profile \
  -v tesla-monitor-state:/app/state-data \
  tesla-stock-monitor

docker logs -f tesla-monitor   # 看即時輸出
```

### Phase 4：驗證這整套是否真的繞得過 Akamai（最關鍵、結果未知的一步）

1. 讓 container 跑一段時間（建議至少觀察 1-2 小時、跑 6-12 次檢查週期），透過 `docker logs tesla-monitor` 確認每次檢查的結果
2. **成功判準**：log 裡出現真實的 JSON 判斷結果，例如 `Check result: state=out_of_stock ({"purchasable":false,...})` —— 代表 GCP 的 IP 沒有被擋，或是被暖身技術克服了
3. **失敗判準**：持續出現 `state=unknown` 且原因是 Access Denied / 非 JSON 回應，且情況在跑了 1 小時以上、多個週期後依然沒有改善 —— 代表 GCP 的 IP 被 Akamai 硬擋，跟 GitHub Actions 一樣的結局
4. 不管結果如何，**把實際的 log 內容回報給使用者，用證據說話，不要用「應該可以/應該不行」這種推測性字眼**
5. 如果失敗：依照「執行前必須確認的問題」第 5 點，問使用者要回退本機、換服務商、還是放棄雲端化

## 現況基準（不要破壞）

- 本機方案目前正常運作中：`C:\Users\cky19\Documents\workspace\playground\tesla-stock-monitor\`，Windows Task Scheduler 排程 `TeslaStockMonitor`，每 10 分鐘檢查一次，Telegram 通知已驗證有效
- `state.json` 目前內容：`{"lastStatus": "out_of_stock"}`
- 在雲端版本驗證穩定之前，**本機排程繼續保持開啟**，作為唯一可靠的 fallback
