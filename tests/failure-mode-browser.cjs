const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/browser-check/node_modules/playwright');

const base = process.env.TEST_URL || 'http://127.0.0.1:13000';
const reportPath = process.env.FAILURE_REPORT_PATH || path.resolve('test-results/failure-mode-browser.json');
const report = { baseUrl: base, startedAt: new Date().toISOString(), checks: [], failures: [], skipped: [] };

async function check(name, fn) {
  try {
    await fn();
    report.checks.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function newConsolePage(browser, view, viewport = { width: 1024, height: 1000 }) {
  const context = await browser.newContext({ baseURL: base, viewport, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('terrafield-console-session', JSON.stringify({
      state: { operator: { callsign: 'FAILURE-TEST', role: 'mission-observer', authenticatedAt: new Date().toISOString() }, view: 'landing', privateWorkspace: false },
      version: 0,
    }));
    localStorage.setItem('terrafield-guided-tour', JSON.stringify({ state: { version: 1, status: 'completed', stepIndex: 0 }, version: 1 }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  await page.goto(`${base}/#view=${view}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((next) => location.hash.includes(`view=${next}`), view);
  return { context, page };
}

(async () => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await check('anonymous writes to seeded records are denied', async () => {
      const context = await browser.newContext({ baseURL: base });
      const farms = await (await context.request.get('/api/v1/farms')).json();
      const seeded = farms.farms.find((farm) => !farm.ownerId) || farms.farms[0];
      assert.ok(seeded, 'a public seed farm is required');
      const denied = await context.request.patch(`/api/v1/farms/${seeded.id}`, {
        data: { name: 'stolen' },
        headers: { origin: base, 'idempotency-key': `failure-anonymous-${Date.now()}` },
      });
      assert.equal(denied.status(), 401);
      await context.close();
    });

    if (process.env.TEST_ACCOUNT_EMAIL && process.env.TEST_ACCOUNT_PASSWORD) {
      await check('authenticated create/edit/delete uses verified same-origin idempotent writes', async () => {
        const { context, page } = await newConsolePage(browser, 'explorer');
        await page.goto(`${base}/account`, { waitUntil: 'domcontentloaded' });
        await page.getByLabel('Email').fill(process.env.TEST_ACCOUNT_EMAIL);
        await page.getByLabel('Password').fill(process.env.TEST_ACCOUNT_PASSWORD);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL((url) => !url.pathname.includes('/account'));
        const name = `Browser acceptance ${Date.now()}`;
        const headers = { origin: base, 'content-type': 'application/json', 'idempotency-key': `browser-create-${Date.now()}` };
        const created = await context.request.post('/api/v1/fires/watchlists', { headers, data: { name, lat: -0.28, lon: 36.07, radiusKm: 15, lookbackDays: 3, detectionThreshold: 5 } });
        assert.equal(created.status(), 201);
        const watchlist = (await created.json()).watchlist;
        const patched = await context.request.patch(`/api/v1/fires/watchlists/${watchlist.id}`, { headers: { ...headers, 'idempotency-key': `browser-update-${Date.now()}` }, data: { notes: 'browser acceptance' } });
        assert.equal(patched.status(), 200);
        const removed = await context.request.delete(`/api/v1/fires/watchlists/${watchlist.id}`, { headers: { ...headers, 'idempotency-key': `browser-delete-${Date.now()}` } });
        assert.equal(removed.status(), 200);
        await context.close();
      });
    } else {
      report.skipped.push({ name: 'authenticated create/edit/delete', reason: 'TEST_ACCOUNT_EMAIL/TEST_ACCOUNT_PASSWORD not supplied' });
    }

    await check('offline recovery shows an actionable fault and retries successfully', async () => {
      const { context, page } = await newConsolePage(browser, 'dashboard', { width: 390, height: 844 });
      await page.route('**/api/v1/observations?**', (route) => route.abort('internetdisconnected'));
      await page.getByRole('button', { name: 'Retry request' }).first().click().catch(() => undefined);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('alert').filter({ hasText: 'Telemetry link fault' }).first().waitFor();
      await page.unroute('**/api/v1/observations?**');
      await page.getByRole('button', { name: 'Retry request' }).first().click();
      await page.getByRole('alert').filter({ hasText: 'Telemetry link fault' }).first().waitFor({ state: 'hidden' });
      await context.close();
    });

    await check('a delayed location response cannot replace the newer selection', async () => {
      const { context, page } = await newConsolePage(browser, 'dashboard');
      await page.route('**/api/v1/observations?**', async (route) => {
        const url = new URL(route.request().url());
        const stale = url.searchParams.get('lat') === '-0.28' && url.searchParams.get('lon') === '36.07';
        if (stale) await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            count: stale ? 999 : 1, variables: ['T2M'],
            datasetVersions: [stale ? 'STALE_SELECTION_SENTINEL' : 'CURRENT_SELECTION'],
            firstRetrievedAt: new Date().toISOString(), provenanceNote: 'controlled delayed response',
            series: { T2M: { unit: 'C', points: [{ date: '2026-01-01', value: stale ? 999 : 1 }] } },
            location: { lat: Number(url.searchParams.get('lat') || -0.28), lon: Number(url.searchParams.get('lon') || 36.07) },
          }),
        });
      });
      await page.getByLabel(/region/i).click();
      await page.getByRole('option').nth(1).click();
      await page.waitForTimeout(2500);
      const text = await page.getByRole('main').first().innerText();
      assert.ok(!text.includes('999'), 'stale response populated the newer selection');
      assert.ok(!text.includes('STALE_SELECTION_SENTINEL'), 'stale dataset provenance leaked into the newer selection');
      await context.close();
    });

    await check('provider degradation remains visible and never fabricates data', async () => {
      const { context, page } = await (async () => {
        const made = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        await made.addInitScript(() => {
          localStorage.setItem('terrafield-console-session', JSON.stringify({ state: { operator: { callsign: 'FAILURE-TEST', role: 'mission-observer', authenticatedAt: new Date().toISOString() }, view: 'settings', privateWorkspace: false }, version: 0 }));
          localStorage.setItem('terrafield-guided-tour', JSON.stringify({ state: { version: 1, status: 'completed', stepIndex: 0 }, version: 1 }));
        });
        const nextPage = await made.newPage();
        nextPage.setDefaultTimeout(60_000);
        return { context: made, page: nextPage };
      })();
      await context.route('**/api/v1/system/sources', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkedAt: new Date().toISOString(), probeMs: 5000,
          signs: [{ key: 'NASA_POWER', label: 'NASA POWER', state: 'unreachable', latencyMs: null, checkedAt: new Date().toISOString(), detail: 'controlled outage' }],
          summary: { live: 0, degraded: 0, unreachable: 1 },
          eonet: { ok: false, fresh: false, staleMs: null, days: 10, events: [], note: 'controlled outage' },
          note: 'controlled provider degradation',
        }),
      }));
      await page.goto(`${base}/#view=settings`, { waitUntil: 'domcontentloaded' });
      await page.getByText('UNREACHABLE', { exact: false }).first().waitFor();
      assert.equal(await page.getByText('UNREACHABLE', { exact: false }).first().isVisible(), true);
      await context.close();
    });

    await check('durable queue failure is surfaced without a fake success', async () => {
      const { context, page } = await newConsolePage(browser, 'dashboard', { width: 390, height: 844 });
      await page.route('**/api/v1/analysis/jobs/*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: { id: 'controlled-job', ownerId: null, type: 'power-ingest', status: 'failed', params: '{}', progressNote: null, resultRef: null, error: 'controlled queue failure', correlationId: null, idempotencyKey: null, dedupeKey: null, attempts: 1, maxAttempts: 5, deadlineAt: null, leaseExpiresAt: null, leaseHolder: null, cancelRequested: false, deadLettered: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), enqueuedAt: null },
          result: null, jobUrl: '/api/v1/analysis/jobs/controlled-job',
        }),
      }));
      await page.getByRole('button', { name: /ingest|record/i }).first().click();
      await page.getByRole('alert').filter({ hasText: /controlled queue failure|failed/i }).first().waitFor();
      await context.close();
    });
  } finally {
    await browser.close();
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
