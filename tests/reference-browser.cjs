const assert = require('node:assert/strict');
const { chromium } = require('../tools/browser-check/node_modules/playwright');
const modules = ['landing', 'dashboard', 'explorer', 'analysis', 'farm', 'rotation', 'fire', 'reports', 'provenance', 'settings'];
(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    const crawler = await browser.newContext({ javaScriptEnabled: false });
    const reference = await crawler.newPage();
    for (const moduleName of modules) {
      const response = await reference.goto(`https://terrafieldatlas.us/guide/${moduleName}`);
      assert.equal(response.status(), 200);
      await reference.getByRole('heading', { name: 'Evidence and limitations', exact: true }).waitFor();
      assert.equal(await reference.locator('link[rel=canonical]').getAttribute('href'), `https://terrafieldatlas.us/guide/${moduleName}`);
      assert.equal(await reference.locator(`a[href='/#view=${moduleName}']`).count(), 1);
    }
    console.log('PASS ten module references: JavaScript-disabled HTML, canonical URLs and console links');
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://terrafieldatlas.us/#view=landing');
    const globe = page.getByRole('group', { name: /Stylized mission globe/ });
    await globe.locator('canvas').waitFor({ state: 'visible' });
    await globe.locator('summary').click();
    await globe.locator('details a').first().waitFor({ timeout: 30000 });
    assert.match(await globe.locator('details').innerText(), /NASA EONET/);
    assert.equal(errors.length, 0, errors.join('; '));
    console.log('PASS live 3D canvas, sourced EONET event details and no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });