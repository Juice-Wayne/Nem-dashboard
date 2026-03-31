/**
 * Playwright script to capture annotated screenshots of the NEM Dashboard
 * for the Confluence user guide.
 *
 * Usage:  node docs/capture-screenshots.mjs
 *
 * Captures 6 key screenshots (consolidated — similar tabs share one shot):
 *   1. Dashboard overview (annotated regions of interest)
 *   2. Rebid reason (row selected + copy button)
 *   3. Interconnectors tab
 *   4. Actuals vs 5PD tab
 *   5. Spikes tab (numbered callouts)
 *   6. BR Start tab (numbered callouts)
 *
 * Screenshots are saved to docs/screenshots/
 */

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, "screenshots");
const BASE_URL = "https://nem-rebids-beta.vercel.app";

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function shot(page, name, opts = {}) {
  const path = join(SCREENSHOT_DIR, name);
  await page.screenshot({ path, fullPage: false, ...opts });
  console.log(`  ✓ ${name}`);
}

async function settle(page, ms = 3000) {
  await page.waitForTimeout(ms);
}

async function clickTab(page, label) {
  await page.getByRole("tab", { name: label }).click();
  await settle(page);
}

async function injectAnnotationStyles(page) {
  await page.addStyleTag({
    content: `
      .anno-box {
        position: absolute;
        border: 3px solid #ef4444;
        border-radius: 6px;
        pointer-events: none;
        z-index: 99999;
        box-shadow: 0 0 0 2px rgba(239,68,68,0.25);
      }
      .anno-label {
        position: absolute;
        background: #ef4444;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 4px;
        white-space: nowrap;
        z-index: 100000;
        pointer-events: none;
      }
      .anno-numbered {
        position: absolute;
        min-width: 16px;
        height: 16px;
        padding: 0 3px;
        background: #ef4444;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 10px;
        font-weight: 700;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        line-height: 1;
      }
    `,
  });
}

async function annotateBoxCoords(page, x, y, w, h, label) {
  await page.evaluate(
    ({ x, y, w, h, label }) => {
      // Clamp to viewport
      const bx = Math.max(2, x);
      const by = Math.max(2, y);
      const box = document.createElement("div");
      box.className = "anno-box";
      box.style.left = `${bx}px`;
      box.style.top = `${by}px`;
      box.style.width = `${Math.max(10, w - (bx - x))}px`;
      box.style.height = `${Math.max(10, h - (by - y))}px`;
      document.body.appendChild(box);
      // Place a compact circle label inside top-left of the box
      if (label) {
        const c = document.createElement("div");
        c.className = "anno-numbered";
        c.textContent = label;
        c.style.left = `${Math.max(6, bx + 6)}px`;
        c.style.top = `${Math.max(6, by + 6)}px`;
        document.body.appendChild(c);
      }
    },
    { x, y, w, h, label }
  );
}

async function annotateNumber(page, num, x, y) {
  await page.evaluate(
    ({ num, x, y }) => {
      const c = document.createElement("div");
      c.className = "anno-numbered";
      c.textContent = String(num);
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
      document.body.appendChild(c);
    },
    { num, x, y }
  );
}

async function annotateNumberedBox(page, num, x, y, w, h) {
  // Clamp box so it doesn't go off-screen
  const bx = Math.max(4, x);
  const by = Math.max(4, y);
  await annotateBoxCoords(page, bx, by, w - (bx - x), h - (by - y));
  // Place number circle inside the top-left of the box (never off-screen)
  const nx = Math.max(6, bx + 6);
  const ny = Math.max(6, by + 6);
  await annotateNumber(page, num, nx, ny);
}

async function clearAnnotations(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".anno-box, .anno-label, .anno-numbered").forEach((el) => el.remove());
  });
}

/**
 * Utility: get bounding rect of an element by selector
 */
async function getRect(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, selector);
}

/**
 * Utility: get combined bounding rect of multiple elements
 */
async function getCombinedRect(page, selector) {
  return page.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    if (els.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    els.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) {
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right);
        maxY = Math.max(maxY, r.bottom);
      }
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, selector);
}

// ============================================================

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  console.log(`Navigating to ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 6000);
  await injectAnnotationStyles(page);

  // ──────────────────────────────────────────
  // 1. DASHBOARD OVERVIEW — red boxes for regions of interest
  //    (Prices tab is default — also represents Demand & Sensitivities
  //     since they share the same 5PD/30PD split layout)
  // ──────────────────────────────────────────
  console.log("\n1. Dashboard overview (annotated)");

  // Screenshot 1: Dashboard overview — sequential numbers
  let num = 1;
  const tabsRect = await getRect(page, '[data-slot="tabs-list"]');
  if (tabsRect) await annotateBoxCoords(page, tabsRect.x - 4, tabsRect.y - 4, tabsRect.w + 8, tabsRect.h + 8, String(num++));

  const barRect = await page.evaluate(() => {
    const candidates = document.querySelectorAll("div.absolute");
    for (const c of candidates) {
      if (c.className.includes("left-1/2") && c.querySelector("div")) {
        const r = c.getBoundingClientRect();
        if (r.width > 100) return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return null;
  });
  if (barRect) await annotateBoxCoords(page, barRect.x - 4, barRect.y - 4, barRect.w + 8, barRect.h + 8, String(num++));

  const filterRect = await page.evaluate(() => {
    const selects = document.querySelectorAll('button[role="combobox"]');
    const themeBtn = document.querySelector('button[title*="mode"]');
    const allEls = [...selects];
    if (themeBtn) allEls.push(themeBtn);
    if (allEls.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    allEls.forEach(el => { const r = el.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
  if (filterRect) await annotateBoxCoords(page, filterRect.x - 6, filterRect.y - 6, filterRect.w + 12, filterRect.h + 12, String(num++));

  const cards = await page.$$('[data-slot="card"]');
  if (cards.length >= 1) { const r = await cards[0].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }
  if (cards.length >= 2) { const r = await cards[1].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }
  if (cards.length >= 3) { const r = await cards[2].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }

  await shot(page, "01-dashboard-overview.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  // 2. REBID REASON
  // ──────────────────────────────────────────
  console.log("2. Rebid reason (annotated)");
  const rows = page.locator("tr[role='button']");
  const rowCount = await rows.count();
  if (rowCount > 0) { await rows.first().click(); await settle(page, 1500); }

  const monoRect = await getRect(page, ".font-mono");
  if (monoRect) await annotateBoxCoords(page, monoRect.x - 4, monoRect.y - 4, monoRect.w + 8, monoRect.h + 8, "1");

  await shot(page, "02-rebid-reason.png");
  await clearAnnotations(page);
  if (rowCount > 0) { await rows.first().click(); await settle(page, 500); }

  // ──────────────────────────────────────────
  // 3. INTERCONNECTORS TAB
  // ──────────────────────────────────────────
  console.log("3. Interconnectors tab (annotated)");
  await clickTab(page, "Interconnectors");

  const icFilterRect = await page.evaluate(() => {
    const combos = document.querySelectorAll('button[role="combobox"]');
    const themeBtn = document.querySelector('button[title*="mode"]');
    const allEls = [...combos];
    if (themeBtn) allEls.push(themeBtn);
    if (allEls.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    allEls.forEach(el => { const r = el.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
  num = 1;
  if (icFilterRect) await annotateBoxCoords(page, icFilterRect.x - 6, icFilterRect.y - 6, icFilterRect.w + 12, icFilterRect.h + 12, String(num++));

  const icCards = await page.$$('[data-slot="card"]');
  if (icCards.length >= 1) { const r = await icCards[0].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }
  if (icCards.length >= 2) { const r = await icCards[1].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }
  if (icCards.length >= 3) { const r = await icCards[2].boundingBox(); if (r) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++)); }

  await shot(page, "03-interconnectors.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  // 4. SENSITIVITIES TAB
  // ──────────────────────────────────────────
  console.log("4. Sensitivities tab (annotated)");
  await clickTab(page, "Sensitivities");

  const sensFilterRect = await page.evaluate(() => {
    const combos = document.querySelectorAll('button[role="combobox"]');
    const themeBtn = document.querySelector('button[title*="mode"]');
    const allEls = [...combos];
    if (themeBtn) allEls.push(themeBtn);
    if (allEls.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    allEls.forEach(el => { const r = el.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
  num = 1;
  if (sensFilterRect) await annotateBoxCoords(page, sensFilterRect.x - 6, sensFilterRect.y - 6, sensFilterRect.w + 12, sensFilterRect.h + 12, String(num++));

  const sensCards = await page.$$('[data-slot="card"]');
  for (let i = 0; i < Math.min(sensCards.length, 3); i++) {
    const r = await sensCards[i].boundingBox();
    if (r && r.height > 30) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++));
  }

  await shot(page, "04-sensitivities.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  // 5. ACTUALS VS 5PD
  // ──────────────────────────────────────────
  console.log("5. Actuals vs 5PD tab (annotated)");
  await clickTab(page, "Actuals vs 5PD");

  const actFilterRect = await page.evaluate(() => {
    const combos = document.querySelectorAll('button[role="combobox"]');
    const themeBtn = document.querySelector('button[title*="mode"]');
    const allEls = [...combos];
    if (themeBtn) allEls.push(themeBtn);
    if (allEls.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    allEls.forEach(el => { const r = el.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
  num = 1;
  if (actFilterRect) await annotateBoxCoords(page, actFilterRect.x - 6, actFilterRect.y - 6, actFilterRect.w + 12, actFilterRect.h + 12, String(num++));

  const actCards = await page.$$('[data-slot="card"]');
  for (let i = 0; i < Math.min(actCards.length, 5); i++) {
    const r = await actCards[i].boundingBox();
    if (r && r.height > 30) await annotateBoxCoords(page, r.x - 4, r.y - 4, r.width + 8, r.height + 8, String(num++));
  }

  await shot(page, "05-actuals-vs-5pd.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  // 5. SPIKES TAB — numbered callouts
  // ──────────────────────────────────────────
  console.log("6. Spikes tab (annotated)");
  await clickTab(page, "Spikes");
  // Wait for spikes data — may take longer
  try {
    await page.waitForFunction(
      () => !document.body.textContent.includes("Loading spikes"),
      { timeout: 20000 }
    );
  } catch {
    console.log("   (spikes still loading, capturing anyway)");
  }
  await settle(page, 3000);

  // Discover and annotate UI regions
  const spikeEls = await page.evaluate(() => {
    const result = [];
    const buttons = Array.from(document.querySelectorAll("button"));

    // Time range buttons (24h, 3d, 7d)
    const timeBtns = buttons.filter(b => ["24h", "3d", "7d"].includes(b.textContent?.trim()));
    if (timeBtns.length) {
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      timeBtns.forEach(b => { const r = b.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
      result.push({ id: "time", x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }

    // Region buttons
    const regBtns = buttons.filter(b => {
      const t = b.textContent?.trim();
      return ["All", "QLD", "NSW", "VIC", "SA"].includes(t) && b.closest('[role="tablist"]') === null;
    });
    if (regBtns.length) {
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      regBtns.forEach(b => { const r = b.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
      result.push({ id: "region", x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }

    // Severity buttons
    const sevBtns = buttons.filter(b => {
      const t = b.textContent?.trim().toUpperCase();
      return ["EXTREME", "HIGH", "NEGATIVE"].includes(t);
    });
    if (sevBtns.length) {
      // Include the "All" that's near severity filters
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      sevBtns.forEach(b => { const r = b.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
      result.push({ id: "severity", x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }

    // First spike card (if data loaded)
    const spikeCards = document.querySelectorAll('[data-slot="card"]');
    if (spikeCards.length > 0) {
      const r = spikeCards[0].getBoundingClientRect();
      if (r.height > 20) {
        result.push({ id: "card", x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }

    return result;
  });

  num = 1;
  for (const el of spikeEls) {
    await annotateBoxCoords(page, el.x - 6, el.y - 6, el.w + 12, el.h + 12, String(num++));
  }

  await shot(page, "06-spikes.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  // 6. BR START TAB — numbered callouts
  // ──────────────────────────────────────────
  console.log("7. BR Start tab (annotated)");
  await clickTab(page, "BR Start");
  try {
    await page.waitForFunction(
      () => !document.body.textContent.includes("Loading start analysis"),
      { timeout: 20000 }
    );
  } catch {
    console.log("   (BR Start still loading, capturing anyway)");
  }
  await settle(page, 3000);

  const brEls = await page.evaluate(() => {
    const result = [];
    const buttons = Array.from(document.querySelectorAll("button"));

    // 1 — Title / heading area
    const heading = Array.from(document.querySelectorAll("h2, h3, p, div"))
      .find(el => el.textContent?.includes("BR Start Profitability"));
    if (heading) {
      const r = heading.getBoundingClientRect();
      result.push({ id: "title", x: r.left, y: r.top, w: r.width, h: r.height });
    }

    // 2 — Today / D+1 toggle
    const dayBtns = buttons.filter(b => ["Today", "D+1"].includes(b.textContent?.trim()));
    if (dayBtns.length) {
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      dayBtns.forEach(b => { const r = b.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); });
      result.push({ id: "day", x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }

    // 3 — Price scenario selector
    const selects = document.querySelectorAll("select");
    selects.forEach(s => {
      const r = s.getBoundingClientRect();
      if (r.width > 0) result.push({ id: "price", x: r.left, y: r.top, w: r.width, h: r.height });
    });

    // 4 — Input fields row
    const inputs = document.querySelectorAll("input");
    if (inputs.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      inputs.forEach(inp => {
        const r = inp.getBoundingClientRect();
        if (r.width > 0) { minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); }
      });
      // Expand a bit to include labels
      result.push({ id: "inputs", x: minX - 30, y: minY - 4, w: (maxX - minX) + 60, h: (maxY - minY) + 8 });
    }

    // 5 — SRMC readout
    const srmcEl = Array.from(document.querySelectorAll("span, div"))
      .find(el => el.textContent?.includes("SRMC") && el.children.length <= 2);
    if (srmcEl) {
      const r = srmcEl.getBoundingClientRect();
      result.push({ id: "srmc", x: r.left, y: r.top, w: r.width, h: r.height });
    }

    // 6 — Chart (if rendered)
    const chart = document.querySelector("[class*='recharts-wrapper'], svg.recharts-surface");
    if (chart) {
      const r = chart.getBoundingClientRect();
      if (r.height > 50) result.push({ id: "chart", x: r.left, y: r.top, w: r.width, h: r.height });
    }

    // 7 — Results table (if rendered)
    const tables = document.querySelectorAll("table");
    // The BR start table is below the chart
    if (tables.length > 0) {
      const t = tables[tables.length - 1];
      const r = t.getBoundingClientRect();
      if (r.height > 20) result.push({ id: "table", x: r.left, y: r.top, w: r.width, h: r.height });
    }

    return result;
  });

  num = 1;
  for (const el of brEls) {
    await annotateBoxCoords(page, el.x - 6, el.y - 6, el.w + 12, el.h + 12, String(num++));
  }

  await shot(page, "07-br-start.png");
  await clearAnnotations(page);

  // ──────────────────────────────────────────
  await browser.close();
  console.log(`\nDone! 7 screenshots saved to: ${SCREENSHOT_DIR}`);
})();
