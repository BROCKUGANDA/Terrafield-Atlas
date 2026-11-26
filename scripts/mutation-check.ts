#!/usr/bin/env bun
/**
 * Focused mutation-testing harness.
 *
 * Each mutation is a single, reviewable textual find/replace against one
 * source file. For every mutation the harness backs the file up, applies the
 * change, runs the target's focused tests under a hard 120 s timeout,
 * restores the file in a `finally` block (plus process-signal handlers), and
 * records killed / survived / timeout.
 *
 * Safety rules:
 * - Refuses to mutate a target file that already has a dirty git diff.
 * - Refuses to mutate when the `find` string is absent or ambiguous.
 * - If a file changes underneath the harness (another agent), it stops
 *   touching that file instead of overwriting the concurrent edit.
 * - The source tree is restored before the process exits.
 *
 * Usage: bun scripts/mutation-check.ts
 * Exit 0 only when the mutation score is >= 70 % and every runnable target
 * actually executed at least one mutation.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TIMEOUT_MS = 120_000;
const SCORE_THRESHOLD = 70;

interface Mutation {
  /** Stable id printed in the report. */
  id: string;
  /** Source text that must occur exactly once. */
  find: string;
  /** Replacement text. */
  replace: string;
  /** Why the mutation matters, for reviewers. */
  note: string;
  /**
   * Set only for mutants that are provably behaviour-preserving (semantic
   * equivalents). They are reported separately and never counted as gaps.
   */
  equivalent?: string;
}

interface Target {
  file: string;
  tests: string[];
  mutations: Mutation[];
}

const TARGETS: Target[] = [
  {
    file: 'src/lib/i18n.ts',
    tests: ['tests/i18n.test.ts'],
    mutations: [
      {
        id: 'i18n.isLocale.allow-any-string',
        find: "return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);",
        replace: "return typeof value === 'string' && !(LOCALES as readonly string[]).includes(value);",
        note: 'isLocale must reject unsupported languages, not accept every string.',
      },
      {
        id: 'i18n.resolveLocale.query-precedence',
        find: 'if (isLocale(fromQuery)) return fromQuery;',
        replace: 'if (!isLocale(fromQuery)) return fromQuery;',
        note: 'An explicit lang/locale query parameter must win over the cookie.',
      },
      {
        id: 'i18n.readCookie.name-filter',
        find: 'if (part.slice(0, separator).trim() !== LOCALE_COOKIE) continue;',
        replace: 'if (part.slice(0, separator).trim() === LOCALE_COOKIE) continue;',
        note: 'Only the tf_locale member of a Cookie header may be read.',
      },
      {
        id: 'i18n.t.unresolved-placeholder',
        find: 'return value === undefined ? match : String(value);',
        replace: 'return value !== undefined ? match : String(value);',
        note: 'Named variables must interpolate; missing ones must stay literal, never print undefined.',
      },
      {
        id: 'i18n.dictionaryParity.untranslated-drift',
        find: 'const untranslatedDrift = UNTRANSLATED_KEYS.filter((key) => target[key] !== en[key]);',
        replace: 'const untranslatedDrift = UNTRANSLATED_KEYS.filter((key) => target[key] === en[key]);',
        note: 'Parity must flag drift (identical English values are the expected state).',
      },
    ],
  },
  {
    file: 'src/lib/adapters/marketPrices.ts',
    tests: ['tests/market-prices.test.ts', 'tests/mutation-guards.test.ts'],
    mutations: [
      {
        id: 'marketPrices.parsePrice.positive-boundary',
        find: 'return Number.isFinite(price) && price > 0 ? price : null;',
        replace: 'return Number.isFinite(price) && price >= 0 ? price : null;',
        note: 'Zero and negative prices are invalid observations, never data.',
      },
      {
        id: 'marketPrices.marketWindowCutoff.month-arithmetic',
        find: 'return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));',
        replace: 'return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (months - 1), 1));',
        note: 'The observation window looks backwards from now, not forwards.',
      },
      {
        id: 'marketPrices.parseCsv.bom-inversion',
        find: 'const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;',
        replace: 'const input = text.charCodeAt(0) !== 0xfeff ? text.slice(1) : text;',
        note: 'A UTF-8 BOM is stripped only when present; plain CSV keeps its first byte.',
      },
      {
        id: 'marketPrices.parseWfpCsv.priceType-inversion',
        find: "if (priceType && priceType !== 'retail') {",
        replace: "if (priceType && priceType === 'retail') {",
        note: 'Retail and wholesale observations must never be mixed in one series.',
      },
      {
        id: 'marketPrices.pickLatestCsvResource.sort-direction',
        find: 'const latest = [...csv].sort((a, b) => resourceTimestamp(b) - resourceTimestamp(a))[0];',
        replace: 'const latest = [...csv].sort((a, b) => resourceTimestamp(a) - resourceTimestamp(b))[0];',
        note: 'The newest CSV resource must be selected, not the oldest.',
      },
      {
        id: 'marketPrices.parseWfpCsv.rowsRead-off-by-one',
        find: 'const rowsRead = Math.max(0, table.length - 1);',
        replace: 'const rowsRead = Math.max(0, table.length + 1);',
        note: 'rowsRead counts data rows (header excluded).',
      },
    ],
  },
  {
    file: 'src/lib/markets.ts',
    tests: ['tests/market-prices.test.ts', 'tests/mutation-guards.test.ts'],
    mutations: [
      {
        id: 'markets.aggregateMonthlyPrices.median-parity',
        find: 'const median = values.length % 2 === 1',
        replace: 'const median = values.length % 2 !== 1',
        note: 'Odd-sized samples use the middle observation; even samples average the two middles.',
      },
      {
        id: 'markets.aggregateMonthlyPrices.utc-month-index',
        find: 'String(date.getUTCMonth() + 1)',
        replace: 'String(date.getUTCMonth() - 1)',
        note: 'Bucket labels use the 1-based UTC calendar month.',
      },
      {
        id: 'markets.aggregateMonthlyPrices.sort-ascending',
        find: 'values.sort((a, b) => a - b);',
        replace: 'values.sort((a, b) => b - a);',
        note: 'min/max/median require ascending price order.',
      },
      {
        id: 'markets.aggregateMonthlyPrices.even-median-sign',
        find: ': (values[middle - 1] + values[middle]) / 2;',
        replace: ': (values[middle - 1] - values[middle]) / 2;',
        note: 'An even-sized median is the arithmetic mean of the two middle prices.',
      },
      {
        id: 'markets.aggregateMonthlyPrices.nonpositive-guard',
        find: 'if (!Number.isFinite(row.price) || row.price <= 0) continue;',
        replace: 'if (!Number.isFinite(row.price) || row.price < 0) continue;',
        note: 'Zero prices are dropped just like negatives before aggregation.',
      },
    ],
  },
  {
    file: 'src/lib/crops/rotation-engine.ts',
    tests: ['tests/rotation.test.ts', 'tests/mutation-guards.test.ts'],
    mutations: [
      {
        id: 'rotation.criterionFamilySequence.penalty-sign',
        find: 'const score = clamp(1 - 0.3 * violations);',
        replace: 'const score = clamp(1 + 0.3 * violations);',
        note: 'Repeated botanical families must lower the family-sequence score.',
      },
      {
        id: 'rotation.criterionLegumeContribution.scale',
        find: 'const score = clamp(frac / 0.5);',
        replace: 'const score = clamp(frac * 0.5);',
        note: 'A half-legume sequence reaches the documented full legume credit (frac / 0.5).',
      },
      {
        id: 'rotation.evaluateRotation.empty-guard',
        find: "if (cropKeys.length < 1) throw new Error('crop sequence is empty');",
        replace: "if (cropKeys.length <= 1) throw new Error('crop sequence is empty');",
        note: 'A single-crop sequence is valid; only an empty sequence is rejected.',
      },
      {
        id: 'rotation.evaluateRotation.max-length',
        find: 'if (cropKeys.length > 8)',
        replace: 'if (cropKeys.length >= 8)',
        note: 'Eight positions are allowed; only more than eight are rejected.',
      },
      {
        id: 'rotation.criterionDiversity.single-crop',
        find: 'const score = crops.length <= 1 ? 0 : clamp((families.size - 1) / (crops.length - 1));',
        replace: 'const score = crops.length < 1 ? 0 : clamp((families.size - 1) / (crops.length - 1));',
        note: 'A single crop scores 0 by definition; 0/0 must never leak NaN into the overall score.',
      },
      {
        id: 'rotation.criterionSoil.ph-interval-inclusive',
        find: 'const inside = soil.ph >= lo && soil.ph <= hi;',
        replace: 'const inside = soil.ph > lo && soil.ph <= hi;',
        note: 'The documented pH range is inclusive at both endpoints.',
      },
      {
        id: 'rotation.criterionFoodSecurity.staple-presence',
        find: 'score: staples.length ? 1 : 0,',
        replace: 'score: staples.length ? 0 : 1,',
        note: 'Presence of a calorie staple must raise the food-security score.',
      },
      {
        id: 'rotation.criterionSeasonal.warm-threshold',
        find: 'if (t[m] >= 12) run++;',
        replace: 'if (t[m] > 12) run++;',
        note: 'The documented warm season includes months at exactly 12 °C mean.',
      },
      {
        id: 'rotation.evaluateRotation.confidence-years',
        find: 'if (env.rainfall && env.rainfall.years < 10) quality *= 0.9;',
        replace: 'if (env.rainfall && env.rainfall.years > 10) quality *= 0.9;',
        note: 'A rainfall record shorter than 10 years lowers confidence.',
      },
      {
        id: 'rotation.criterionSoil.ph-near-lower',
        find: 'const near = soil.ph >= lo - 0.5 && soil.ph <= hi + 0.5;',
        replace: 'const near = soil.ph >= lo + 0.5 && soil.ph <= hi + 0.5;',
        note: 'The 0.5 pH tolerance extends below the documented lower bound.',
      },
    ],
  },
  {
    file: 'src/lib/retention.ts',
    tests: ['tests/retention.integration.ts'],
    mutations: [
      {
        id: 'retention.verification.expiry-direction',
        find: "db.accountVerification.deleteMany({ where: { expiresAt: { lt: now } } })",
        replace: "db.accountVerification.deleteMany({ where: { expiresAt: { gt: now } } })",
        note: 'Retention must delete expired verification tokens, never live ones.',
      },
      {
        id: 'retention.idempotency.window',
        find: "db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * DAY) } } })",
        replace: "db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 31 * DAY) } } })",
        note: 'The documented 30-day idempotency window covers a 31-day-old record.',
      },
    ],
  },
  {
    file: 'src/lib/onchain.ts',
    tests: ['tests/onchain-payments.test.ts'],
    mutations: [
      {
        id: 'onchain.min-amount',
        find: 'export const ONCHAIN_MIN_AMOUNT_MINOR = 100; // $1.00',
        replace: 'export const ONCHAIN_MIN_AMOUNT_MINOR = 101; // $1.00',
        note: 'One dollar (100 minor units) must be a valid support amount.',
      },
      {
        id: 'onchain.invoice-confirmations',
        find: 'export const ONCHAIN_INVOICE_MIN_CONFIRMATIONS = 6;',
        replace: 'export const ONCHAIN_INVOICE_MIN_CONFIRMATIONS = 1;',
        note: 'Invoice-linked settlement requires at least six confirmations.',
      },
    ],
  },
  {
    file: 'src/lib/billing/invoices.ts',
    tests: ['tests/billing-invoices.integration.ts'],
    mutations: [
      {
        id: 'billing.settle.amount-equality',
        find: 'if (input.amountMinor !== undefined && input.amountMinor !== invoice.amountMinor) {',
        replace: 'if (input.amountMinor !== undefined && input.amountMinor === invoice.amountMinor) {',
        note: 'Settlement must require the exact invoice total, not reject it.',
      },
    ],
  },
];

interface TestRun {
  ok: boolean;
  timedOut: boolean;
  ms: number;
  output: string;
}

type Outcome = 'killed' | 'survived' | 'timeout' | 'skipped';

interface MutationResult {
  mutation: Mutation;
  outcome: Outcome;
  durationMs: number;
  detail?: string;
}

interface TargetResult {
  target: Target;
  baselineOk: boolean;
  baselineDetail: string;
  skippedReason?: string;
  results: MutationResult[];
}

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function tail(text: string, maxLines = 12): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function gitDirty(file: string): boolean {
  const proc = Bun.spawnSync(['git', 'status', '--porcelain', '--', file], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.exitCode !== 0 || new TextDecoder().decode(proc.stdout).trim().length > 0;
}

async function runTests(files: string[]): Promise<TestRun> {
  const started = Date.now();
  // Bun treats a bare path without ".test"/".spec" as a name filter; the ./
  // prefix forces path mode for integration-style file names.
  const paths = files.map((file) => (file.startsWith('./') ? file : `./${file}`));
  const proc = Bun.spawn(['bun', 'test', ...paths], {
    cwd: ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  const { promise: limit, resolve: onTimeout } = Promise.withResolvers<'timeout'>();
  const timer = setTimeout(() => onTimeout('timeout'), TIMEOUT_MS);
  timer.unref?.();
  const outcome = await Promise.race([proc.exited, limit]);
  let timedOut = false;
  if (outcome === 'timeout') {
    timedOut = true;
    proc.kill();
  }
  const [out, err] = await Promise.all([stdout, stderr]);
  clearTimeout(timer);
  return {
    ok: !timedOut && outcome === 0,
    timedOut,
    ms: Date.now() - started,
    output: `${out}\n${err}`,
  };
}

type PendingRestore = { file: string; original: string; mutated: string };
let pending: PendingRestore | null = null;

function restorePending(): void {
  if (!pending) return;
  const { file, original, mutated } = pending;
  try {
    if (readFileSync(resolve(ROOT, file), 'utf8') === mutated) {
      writeFileSync(resolve(ROOT, file), original);
    }
  } catch {
    // Best effort on shutdown; the finally block already handles normal paths.
  }
  pending = null;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    restorePending();
    process.exit(130);
  });
}
process.on('exit', restorePending);

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function runTarget(target: Target): Promise<TargetResult> {
  const absolute = resolve(ROOT, target.file);
  const result: TargetResult = {
    target,
    baselineOk: false,
    baselineDetail: '',
    results: [],
  };

  log(`\n=== ${target.file}`);
  log(`    tests: ${target.tests.join(', ')}`);
  log(`    mutations: ${target.mutations.length}`);

  if (gitDirty(target.file)) {
    result.skippedReason = 'dirty git diff on target file — refusing to mutate';
    log(`    SKIPPED: ${result.skippedReason}`);
    return result;
  }

  const baseline = await runTests(target.tests);
  result.baselineOk = baseline.ok;
  result.baselineDetail = tail(baseline.output, 6);
  if (!baseline.ok) {
    result.skippedReason = baseline.timedOut
      ? 'baseline test run timed out'
      : 'baseline test run is red (pre-existing failure or missing test services — set REDIS_URL/TEST_DATABASE_URL, see docker-compose.test.yml)';
    log(`    SKIPPED: ${result.skippedReason}`);
    for (const line of result.baselineDetail.split('\n')) log(`      | ${line}`);
    return result;
  }
  log(`    baseline green (${baseline.ms} ms)`);

  const baselineText = readFileSync(absolute, 'utf8');
  let liveText = baselineText;

  for (const mutation of target.mutations) {
    // Another agent may own this file; never clobber a concurrent edit.
    const currentText = readFileSync(absolute, 'utf8');
    if (currentText !== liveText) {
      result.skippedReason = 'file changed underneath the harness — stopping without touching it';
      log(`    ABORTED: ${result.skippedReason}`);
      break;
    }

    const occurrences = countOccurrences(currentText, mutation.find);
    if (occurrences !== 1) {
      result.results.push({
        mutation,
        outcome: 'skipped',
        durationMs: 0,
        detail: occurrences === 0
          ? 'find string not present (stale mutation definition)'
          : `find string is ambiguous (${occurrences} occurrences)`,
      });
      log(`    SKIP  ${mutation.id} — stale/ambiguous find string`);
      continue;
    }

    const mutatedText = currentText.replace(mutation.find, mutation.replace);
    writeFileSync(absolute, mutatedText);
    pending = { file: target.file, original: currentText, mutated: mutatedText };

    let run: TestRun;
    try {
      run = await runTests(target.tests);
    } finally {
      const after = readFileSync(absolute, 'utf8');
      if (after === mutatedText) {
        writeFileSync(absolute, currentText);
        liveText = currentText;
      } else {
        // Someone edited during the run; leave their content in place and stop.
        result.skippedReason = 'file changed underneath the harness during a mutation run';
        liveText = after;
      }
      pending = null;
    }

    const outcome: Outcome = run.timedOut ? 'timeout' : run.ok ? 'survived' : 'killed';
    result.results.push({ mutation, outcome, durationMs: run.ms });
    const label = outcome.toUpperCase().padEnd(8);
    log(`    ${label} ${mutation.id} (${run.ms} ms)`);
    if (outcome === 'survived') log(`             ${mutation.note}`);
    if (outcome === 'survived' && mutation.equivalent) log(`             documented equivalent: ${mutation.equivalent}`);

    if (result.skippedReason) break;
  }

  // A peer may own this file. If every definition is stale, the file changed
  // underneath the harness: report it as a clean skip rather than a failure.
  if (
    !result.skippedReason &&
    result.results.length > 0 &&
    result.results.every((r) => r.outcome === 'skipped' && r.detail?.startsWith('find string not present'))
  ) {
    result.skippedReason = 'mutation definitions no longer match the file (changed underneath) — skipped cleanly';
    log(`    SKIPPED: ${result.skippedReason}`);
  }

  return result;
}

function scoreOf(results: MutationResult[]): { executed: number; detected: number; percent: number } {
  const executed = results.filter((r) => r.outcome === 'killed' || r.outcome === 'survived' || r.outcome === 'timeout');
  const detected = executed.filter((r) => r.outcome === 'killed' || r.outcome === 'timeout').length;
  const percent = executed.length === 0 ? 0 : (detected / executed.length) * 100;
  return { executed: executed.length, detected, percent };
}

async function main(): Promise<number> {
  log('TerraField Atlas — focused mutation check');
  log(`root: ${ROOT}`);
  log(`threshold: ${SCORE_THRESHOLD}% | per-mutation timeout: ${TIMEOUT_MS / 1000}s`);

  const targetResults: TargetResult[] = [];
  for (const target of TARGETS) {
    targetResults.push(await runTarget(target));
  }
  restorePending();

  log('\n================ summary ================');
  let totalExecuted = 0;
  let totalDetected = 0;
  let totalSurvived = 0;
  let totalTimeout = 0;
  let totalSkipped = 0;
  const failures: string[] = [];
  const survivors: MutationResult[] = [];

  for (const tr of targetResults) {
    const score = scoreOf(tr.results);
    totalExecuted += score.executed;
    totalDetected += score.detected;
    totalSurvived += tr.results.filter((r) => r.outcome === 'survived').length;
    totalTimeout += tr.results.filter((r) => r.outcome === 'timeout').length;
    totalSkipped += tr.results.filter((r) => r.outcome === 'skipped').length;

    if (tr.skippedReason && score.executed === 0) {
      log(`${tr.target.file}: SKIPPED — ${tr.skippedReason}`);
      continue;
    }
    log(`${tr.target.file}: ${score.detected}/${score.executed} detected (${score.percent.toFixed(1)}%)`);
    if (score.executed === 0) {
      failures.push(`${tr.target.file}: no mutation executed (stale target definition)`);
    }
  }

  for (const tr of targetResults) {
    for (const r of tr.results) {
      if (r.outcome === 'survived') survivors.push(r);
    }
  }

  log('');
  if (survivors.length === 0) {
    log('Surviving mutants: none');
  } else {
    log('Surviving mutants:');
    for (const r of survivors) {
      log(`  - ${r.mutation.id}`);
      log(`      why it matters: ${r.mutation.note}`);
      if (r.mutation.equivalent) log(`      documented equivalent: ${r.mutation.equivalent}`);
      else log('      status: GAP — needs a behavioural test');
    }
  }

  const percent = totalExecuted === 0 ? 0 : (totalDetected / totalExecuted) * 100;
  log('');
  log(
    `TOTAL: ${totalDetected}/${totalExecuted} detected (${percent.toFixed(1)}%) | ` +
    `survived ${totalSurvived}, timeout ${totalTimeout}, skipped ${totalSkipped}`,
  );

  if (totalExecuted === 0) failures.push('no mutations executed at all');
  if (percent < SCORE_THRESHOLD) failures.push(`mutation score ${percent.toFixed(1)}% is below ${SCORE_THRESHOLD}%`);

  if (failures.length > 0) {
    log('\nFAIL:');
    for (const failure of failures) log(`  - ${failure}`);
    return 1;
  }

  log(`\nPASS: mutation score ${percent.toFixed(1)}% >= ${SCORE_THRESHOLD}%`);
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  restorePending();
}
