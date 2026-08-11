'use strict';
/**
 * browserFetch.js
 * Uses Playwright (headless Chrome) to fetch pages from stats.ncaa.org,
 * which is a JavaScript-rendered SPA that node-fetch can't parse.
 *
 * Uses your already-installed Google Chrome — no separate browser download needed.
 */

const path = require('path');

// Reuse a single browser instance across calls (much faster)
let _browser   = null;
let _playwright = null;

// Common Chrome install paths on Windows
const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

async function getBrowser() {
  if (_browser) {
    // Check it's still alive
    try { _browser.version(); return _browser; } catch (e) { _browser = null; }
  }

  if (!_playwright) {
    try {
      _playwright = require('playwright');
    } catch (e) {
      throw new Error(
        'Playwright not installed. Run this command in your ncaa-scout folder:\n' +
        '  npm install\n' +
        'Then restart the server.'
      );
    }
  }

  const { chromium } = _playwright;

  // 1. Try "chrome" channel — uses your installed Google Chrome automatically
  try {
    _browser = await chromium.launch({ channel: 'chrome', headless: true });
    console.log('[browser] Launched via Chrome channel');
    return _browser;
  } catch (e) { /* fall through */ }

  // 2. Try explicit Windows paths
  for (const exePath of CHROME_PATHS_WIN) {
    try {
      _browser = await chromium.launch({ executablePath: exePath, headless: true });
      console.log('[browser] Launched Chrome from', exePath);
      return _browser;
    } catch (e) { /* next path */ }
  }

  // 3. Try CHROME_PATH env var
  if (process.env.CHROME_PATH) {
    try {
      _browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
      console.log('[browser] Launched Chrome from CHROME_PATH:', process.env.CHROME_PATH);
      return _browser;
    } catch (e) { /* fall through */ }
  }

  // 4. Let Playwright download its own Chromium as last resort
  try {
    _browser = await chromium.launch({ headless: true });
    console.log('[browser] Launched Playwright bundled Chromium');
    return _browser;
  } catch (e) {
    throw new Error(
      'Could not find Chrome. Set the CHROME_PATH environment variable:\n' +
      '  set CHROME_PATH=C:\\Path\\To\\chrome.exe\n' +
      'Or run: npx playwright install chromium'
    );
  }
}

/**
 * Fetch a page URL using a real headless Chrome browser.
 * Waits for the page to finish rendering (networkidle or table appears).
 * Returns the fully-rendered HTML string.
 */
async function fetchHTMLWithBrowser(url, { waitForSelector = 'table', timeout = 45000 } = {}) {
  const browser = await getBrowser();

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = await context.newPage();

  try {
    // Use 'load' (DOMContentLoaded + subresources) rather than 'networkidle'.
    // NCAA pages keep long-poll connections open so 'networkidle' never resolves.
    await page.goto(url, { waitUntil: 'load', timeout });

    // Then wait for the data table to appear — this is what the JS renders async.
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 15000 }).catch(() => {
        // Non-fatal — some pages (postponed games, no-PBP) won't have a table.
      });
    }

    // Brief settle so Angular/Vue/etc finish binding data to the DOM
    await page.waitForTimeout(800);

    return await page.content();
  } finally {
    await page.close();
    await context.close();
  }
}

/**
 * Graceful shutdown — call this when the server exits.
 */
async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (e) {}
    _browser = null;
  }
}

module.exports = { fetchHTMLWithBrowser, getBrowser, closeBrowser };
