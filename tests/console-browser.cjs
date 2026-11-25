const assert = require('node:assert/strict');
const { chromium } = require('../tools/browser-check/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.TEST_URL || 'http://localhost:3000', { waitUntil: 'domcontentloaded' });
    const nav = page.getByRole('navigation', { name: 'Console navigation' }).filter({ visible: true });
    await nav.getByRole('button', { name: 'Geospatial Explorer', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('view=explorer'), null, { timeout: 15000 });
    await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-tour="explorer-map"]').evaluate((element) => {
      for (let node = element; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) === 0) return false;
      }
      return true;
    }), true, 'Map must not be hidden by an entrance animation');
    await page.keyboard.press('Escape');
    await page.getByLabel('Observation date for GIBS layers').fill('');
    assert.notEqual(await page.getByLabel('Observation date for GIBS layers').inputValue(), '');
    await page.getByLabel('Latitude of the target coordinate').fill('91');
    assert.notEqual(await page.getByLabel('Latitude of the target coordinate').inputValue(), '91');
    for (const [label, view] of [['Environmental Analysis', 'analysis'], ['Earth Intelligence', 'dashboard'], ['Data Catalogue', 'sources'], ['Fire Intelligence', 'fire'], ['Farm Workspace', 'farm'], ['Rotation Planner', 'rotation'], ['Field Reports', 'reports'], ['Organization Workspace', 'organizations'], ['Plans & Usage', 'billing'], ['Atlas Intelligence', 'intelligence'], ['Evidence & Provenance', 'provenance'], ['Platform Administration', 'admin'], ['System Health', 'settings'], ['Mission Overview', 'landing'], ['Geospatial Explorer', 'explorer']]) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction((view) => location.hash.includes(`view=${view}`), view);
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => { location.hash = 'view=reports'; });
    await page.waitForFunction(() => document.querySelector('[aria-current="page"]')?.textContent.includes('Field Reports'));
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[aria-current="page"]')?.textContent.includes('Geospatial Explorer'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open console navigation' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'System Health', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('view=settings'));
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('dialog').count(), 0, 'Mobile navigation closes');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log('PASS: all sidebar modules, explorer canvas, invalid inputs, browser history, mobile navigation');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });