const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PRODUCT_URL = 'https://shop.tesla.com/ja_jp/product/gen-2-mobile-connector-bundle-jp';
const OUT_OF_STOCK_TEXT = '在庫切れ';
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE = path.join(__dirname, 'monitor.log');
// Local Windows fallback only - GitHub Actions provides these via env vars (Secrets).
const LOCAL_ENV_FILE = 'C:\\Users\\cky19\\.claude\\channels\\telegram\\.env';
const DEFAULT_CHAT_ID = '5964743393';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastStatus: 'unknown' };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const envContent = fs.readFileSync(LOCAL_ENV_FILE, 'utf8');
  const match = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
  if (!match) throw new Error('TELEGRAM_BOT_TOKEN not found in env or local .env file');
  return match[1].trim();
}

function getChatId() {
  return (process.env.TELEGRAM_CHAT_ID || DEFAULT_CHAT_ID).trim();
}

async function sendTelegramMessage(text) {
  const token = getBotToken();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: getChatId(), text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

// Akamai blocks headless Chrome outright (returns a 403 "Access Denied" page
// with no product content). A real, headed Chrome is required to get past
// its bot detection. The window is pushed off-screen so it doesn't disturb
// the user even though it's technically visible.
const PAGE_LOAD_CONFIRMATIONS = ['¥47,500', 'GEN II モバイルコネクター', 'カートに入れる'];

async function checkStock() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--window-position=-2400,-2400', '--window-size=1280,900'],
  });
  try {
    const context = await browser.newContext({
      locale: 'ja-JP',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const resp = await page.goto(PRODUCT_URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(4000);

    const bodyText = await page.textContent('body');
    const pageLoadedProperly = PAGE_LOAD_CONFIRMATIONS.some((marker) => bodyText.includes(marker));

    if (!pageLoadedProperly) {
      throw new Error(
        `Page did not load expected product content (HTTP ${resp.status()}, title="${await page.title()}") - likely blocked by Akamai. Treating as inconclusive, not as in-stock.`
      );
    }

    const outOfStock = bodyText.includes(OUT_OF_STOCK_TEXT);
    return { inStock: !outOfStock, rawSnippet: outOfStock ? OUT_OF_STOCK_TEXT : '(no out-of-stock badge found)' };
  } finally {
    await browser.close();
  }
}

async function main() {
  const state = loadState();
  let result;
  try {
    result = await checkStock();
  } catch (err) {
    log(`ERROR checking stock: ${err.message}`);
    return;
  }

  log(`Check result: inStock=${result.inStock} (${result.rawSnippet})`);

  const newStatus = result.inStock ? 'in_stock' : 'out_of_stock';

  if (newStatus === 'in_stock' && state.lastStatus !== 'in_stock') {
    log('Status changed to IN STOCK -> sending Telegram notification');
    try {
      await sendTelegramMessage(
        `🔋 Tesla GEN II モバイルコネクター 現在有庫存！\n\n${PRODUCT_URL}\n\n(在庫切れ 標示已消失,請盡快確認並購買)`
      );
      log('Telegram notification sent successfully');
    } catch (err) {
      log(`ERROR sending Telegram message: ${err.message}`);
    }
  }

  // lastCheckedAt intentionally not persisted to state.json - it would make the
  // file change on every run, forcing a git commit each time in CI. Timestamps
  // live in the log instead; state.json only changes on a real status transition.
  state.lastStatus = newStatus;
  saveState(state);
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
