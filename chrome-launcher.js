// Launches (or reuses) a dedicated, persistent Chrome instance with a remote
// debugging port. Kept separate from the user's daily-driver Chrome profile.
// The monitor attaches to this via CDP instead of spawning a fresh automated
// browser each check - a real, already-warmed Chrome session is far less
// likely to be blocked by Akamai than a freshly-launched one.
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT_WAIT_RETRIES = 40;
const PORT_WAIT_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDebugPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureMonitorChrome({ port, profileDir }) {
  if (await isDebugPortOpen(port)) {
    return { alreadyRunning: true };
  }

  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error(`Chrome not found at ${CHROME_EXE}`);
  }
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-2400,-2400',
    '--window-size=1280,900',
  ];
  const child = spawn(CHROME_EXE, args, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < PORT_WAIT_RETRIES; i += 1) {
    if (await isDebugPortOpen(port)) {
      return { alreadyRunning: false };
    }
    await sleep(PORT_WAIT_INTERVAL_MS);
  }
  throw new Error(`Chrome debug port ${port} did not open in time`);
}

module.exports = { ensureMonitorChrome, isDebugPortOpen };
