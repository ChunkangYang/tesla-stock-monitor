const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureMonitorChrome } = require('./chrome-launcher');

const SHOP_TOP_URL = 'https://shop.tesla.com/ja_jp/';
const PRODUCT_URL = 'https://shop.tesla.com/ja_jp/product/gen-2-mobile-connector-bundle-jp';
const INVENTORY_API_URL = 'https://shop.tesla.com/ja_jp/inventory.json';
const SKU_CODE = '1458882-00-D';
const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;
const CHROME_PROFILE_DIR = path.join(__dirname, '.chrome-profile');
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

// Pure function run inside the page via page.evaluate. Posts to Tesla's own
// inventory API from a same-origin tesla.com page context (so the request
// carries the page's Akamai session cookies) instead of scraping the DOM.
async function fetchInventoryInPage({ apiUrl, skuCode }) {
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([skuCode]),
      credentials: 'include',
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: true, status: res.status, json, textSnippet: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, json: null, textSnippet: '', error: e?.message ?? String(e) };
  }
}

// entry.purchasable is the authoritative signal; inventoryCount can be 0 even
// when in stock, so it's only used as a secondary positive signal.
function judgeInventory(raw, skuCode) {
  if (!raw || raw.ok !== true || raw.status !== 200 || !Array.isArray(raw.json)) {
    return { state: 'unknown', reason: raw?.error ?? raw?.textSnippet ?? 'non-200/non-json response' };
  }
  const entry = raw.json.find((e) => e && e.skuCode === skuCode) || raw.json[0] || null;
  if (!entry || typeof entry !== 'object') {
    return { state: 'unknown', reason: 'no matching entry in response' };
  }
  const count = Number(entry.inventoryCount);
  if (entry.purchasable === true || (Number.isFinite(count) && count > 0)) {
    return { state: 'in_stock', reason: JSON.stringify(entry) };
  }
  if (entry.purchasable === false || entry.error === 'Out of stock') {
    return { state: 'out_of_stock', reason: JSON.stringify(entry) };
  }
  return { state: 'unknown', reason: `ambiguous entry: ${JSON.stringify(entry)}` };
}

// Attaches to a real, persistent Chrome (via CDP) instead of launching a
// fresh automated browser each check - Akamai trusts an authentic, already
// "warmed" browser session far more than a brand-new one. The Chrome process
// is left running (detached) so later scheduled runs reuse the same session.
async function checkStock() {
  await ensureMonitorChrome({ port: CDP_PORT, profileDir: CHROME_PROFILE_DIR });
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const page = await context.newPage();
    try {
      // Warm up on the lightly-protected shop top page first so Akamai's
      // sensor JS validates the _abck cookie before we hit the API directly.
      // 'load' (not 'domcontentloaded') so any client-side redirect the SPA
      // does on entry has already settled before we touch the page context.
      await page.goto(SHOP_TOP_URL, { waitUntil: 'load', timeout: 60000 });
      try {
        await page.mouse.move(420, 360);
        await page.waitForTimeout(500);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(500);
      } catch {
        // Best-effort human-like signal; failure here isn't fatal.
      }
      // Extra settle time: the SPA can still redirect/reload just after
      // 'load' fires, which would destroy the JS context mid-evaluate.
      await page.waitForTimeout(2000);

      let raw;
      try {
        raw = await page.evaluate(fetchInventoryInPage, {
          apiUrl: INVENTORY_API_URL,
          skuCode: SKU_CODE,
        });
      } catch (err) {
        // One retry if the page context got destroyed by a late redirect.
        if (!/Execution context was destroyed/.test(err?.message ?? '')) throw err;
        await page.waitForTimeout(2000);
        raw = await page.evaluate(fetchInventoryInPage, {
          apiUrl: INVENTORY_API_URL,
          skuCode: SKU_CODE,
        });
      }
      const judged = judgeInventory(raw, SKU_CODE);
      return { inStock: judged.state === 'in_stock', state: judged.state, reason: judged.reason };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close(); // Disconnects CDP only - the real Chrome keeps running.
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

  log(`Check result: state=${result.state} (${result.reason})`);

  if (result.state === 'unknown') {
    // Inconclusive (Access Denied page, network error, unexpected API shape).
    // Never treat this as in-stock - skip notifying and leave state.json as-is.
    return;
  }

  const newStatus = result.state; // 'in_stock' | 'out_of_stock'

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
