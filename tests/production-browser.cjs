const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('../tools/browser-check/node_modules/playwright');

const base = process.env.TEST_URL || 'http://localhost:8080';
const reportPath = process.env.TEST_REPORT_PATH || path.resolve('test-results/production-browser.json');
const widths = [320, 375, 390, 768, 1024, 1440];
const modules = [
  ['Mission Overview', 'landing'],
  ['Earth Intelligence', 'dashboard'],
  ['Geospatial Explorer', 'explorer'],
  ['Data Catalogue', 'sources'],
  ['Environmental Analysis', 'analysis'],
  ['Farm Workspace', 'farm'],
  ['Rotation Planner', 'rotation'],
  ['Fire Intelligence', 'fire'],
  ['Field Reports', 'reports'],
  ['Organization Workspace', 'organizations'],
  ['Plans & Usage', 'billing'],
  ['Atlas Intelligence', 'intelligence'],
  ['Evidence & Provenance', 'provenance'],
  ['Platform Administration', 'admin'],
  ['System Health', 'settings'],
];
const report = {
  artifact: process.env.RELEASE_IMAGE || null,
  commit: process.env.GIT_COMMIT || process.env.GITHUB_SHA || null,
  artifactSha256: process.env.ARTIFACT_SHA256 || null,
  baseUrl: base,
  startedAt: new Date().toISOString(),
  browsers: [], assertions: 0, failures: [],
  skipped: [
    { check: 'physical-device certification', reason: 'not executed; viewport/touch emulation only' },
    { check: 'external-provider availability guarantee', reason: 'not certified; controlled degradation is tested separately' },
  ],
};

async function enterConsole(page) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const understood = page.getByRole('button', { name: 'Understood', exact: true });
  if (await understood.isVisible().catch(() => false)) await understood.click();
  await page.keyboard.press('Escape');
  const nav = page.getByRole('button', { name: 'Open console navigation' });
  if (await nav.isVisible().catch(() => false)) {
    try {
      await nav.click({ timeout: 3_000 });
      await page.getByRole('dialog').getByRole('button', { name: 'Geospatial Explorer', exact: true }).click({ timeout: 3_000 });
    } catch {
      const cta = page.locator('main button').filter({ hasText: /console|explorer/i }).first();
      if (await cta.isVisible().catch(() => false)) await cta.click({ timeout: 3_000 }).catch(() => undefined);
      await page.evaluate(() => { location.hash = 'view=explorer'; });
    }
  } else {
    const cta = page.locator('main button').filter({ hasText: /console|explorer/i }).first();
    if (await cta.isVisible().catch(() => false)) await cta.click({ timeout: 3_000 }).catch(() => undefined);
    await page.evaluate(() => { location.hash = 'view=explorer'; });
  }
  await page.waitForFunction(() => location.hash.includes('view=explorer'));
}

async function inspectViewport(page, browser, width, module) {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const clipped = [...document.querySelectorAll('main button, main input, main select, main textarea')]
      .filter(visible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60));
    const smallTargets = matchMedia('(pointer: coarse)').matches
      ? [...document.querySelectorAll('main button')].filter(visible).filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.height < 43.5 || rect.width < 43.5;
        }).map((element) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60))
      : [];
    const footers = [...document.querySelectorAll('footer')].filter(visible).length;
    return { overflow, clipped, smallTargets, footers };
  });
  assert.equal(result.overflow, false, `${browser}/${module}: horizontal page overflow at ${width}`);
  assert.deepEqual(result.clipped, [], `${browser}/${module}: clipped controls at ${width}`);
  assert.deepEqual(result.smallTargets, [], `${browser}/${module}: coarse-pointer targets below 44px at ${width}`);
  assert.ok(result.footers <= 1, `${browser}/${module}: duplicate visible footers at ${width}`);
  report.assertions += 4;
}

(async () => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  for (const [name, engine, options] of [['Edge', chromium, { channel: 'msedge' }], ['Firefox', firefox, {}], ['WebKit', webkit, {}]]) {
    let browser;
    try {
      browser = await engine.launch({ headless: true, ...options });
    } catch (error) {
      report.skipped.push({ browser: name, reason: error.message });
      continue;
    }
    const browserResult = { name, viewports: widths.length, modules: modules.length, passed: 0, failed: 0 };
    report.browsers.push(browserResult);
    try {
      for (const width of widths) {
        const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion: 'reduce', hasTouch: width < 768 });
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        page.setDefaultNavigationTimeout(60_000);
        const pageErrors = [];
        const consoleErrors = [];
        const sameOriginConsoleErrors = [];
        const hydrationWarnings = [];
        const failedRequests = [];
        page.on('pageerror', (error) => {
          if (/ResizeObserver loop completed with undelivered notifications/.test(error.message)) return;
          pageErrors.push(error.message);
        });
        page.on('console', (message) => {
          if (message.type() === 'error') {
            consoleErrors.push(message.text());
            if (message.location().url.startsWith(base) && !/status of (401|403)/.test(message.text())) sameOriginConsoleErrors.push(message.text());
          }
          if (/hydrat/i.test(message.text())) hydrationWarnings.push(message.text());
        });
        page.on('response', (response) => {
          if (response.url().startsWith(base) && response.status() >= 500) failedRequests.push(`${response.status()} ${response.url()}`);
        });
        await enterConsole(page);
        for (const [label, view] of modules) {
          let hashApplied = false;
          for (let attempt = 0; attempt < 3 && !hashApplied; attempt++) {
            await page.evaluate((next) => { location.hash = `view=${next}`; }, view);
            hashApplied = await page.waitForFunction((next) => location.hash.includes(`view=${next}`), view, { timeout: 5_000 }).then(() => true).catch(() => false);
          }
          assert.ok(hashApplied, `${name}/${label}: console route did not update at ${width}`);
          await page.waitForTimeout(150);
          await inspectViewport(page, name, width, label);
          browserResult.passed += 1;
        }
        assert.deepEqual(pageErrors, [], `${name}: uncaught page errors at ${width}`);
        assert.deepEqual(hydrationWarnings, [], `${name}: hydration warnings at ${width}`);
        assert.deepEqual(sameOriginConsoleErrors, [], `${name}: same-origin console errors at ${width}`);
        assert.deepEqual(failedRequests, [], `${name}: same-origin 5xx responses at ${width}`);
        report.assertions += 4;
        await context.close();
      }
    } catch (error) {
      browserResult.failed += 1;
      report.failures.push({ browser: name, error: error.message });
    } finally {
      await browser.close();
    }
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.failures.length === 0 ? 'passed' : 'failed';
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (report.failures.length) process.exitCode = 1;
})().catch((error) => {
  report.failures.push({ error: error.message });
  report.status = 'failed';
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
});
