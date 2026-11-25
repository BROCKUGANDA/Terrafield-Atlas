import { db } from '@/lib/db';
import { stableHash } from '@/lib/cache';
import { isPrivateProvider } from '@/lib/ingest/provider-context';
import { redisRuntime } from '@/lib/redis';
import { fetchPinnedPublicUrl } from '@/lib/network-safety';

/** Resilient provider transport. This module is the only server retry owner. */
export type Provider = 'NASA_POWER' | 'GIBS' | 'SOILGRIDS' | 'FIRMS' | 'EONET' | 'STAC';

export class ProviderUnavailableError extends Error {
  constructor(provider: Provider, detail: string) {
    super(`Provider ${provider} unavailable: ${detail}`);
    this.name = 'ProviderUnavailableError';
  }
}

const FAILURE_THRESHOLD = 4;
const COOLDOWN_MS = 60_000;
const PROVIDERS: Provider[] = ['NASA_POWER', 'GIBS', 'SOILGRIDS', 'FIRMS', 'EONET', 'STAC'];

export async function circuitStatus() {
  if (isPrivateProvider()) return PROVIDERS.map((provider) => ({ provider, consecutiveFailures: 0, open: false, cooldownRemainingMs: 0 }));
  return Promise.all(PROVIDERS.map(async (provider) => ({
    provider,
    ...await redisRuntime().getCircuit(`provider:${provider}`),
  })));
}

async function tripCircuit(provider: Provider) {
  if (isPrivateProvider()) return;
  await redisRuntime().recordCircuitFailure(`provider:${provider}`, { threshold: FAILURE_THRESHOLD, cooldownMs: COOLDOWN_MS });
}

async function clearCircuit(provider: Provider) {
  if (isPrivateProvider()) return;
  await redisRuntime().resetCircuit(`provider:${provider}`);
}

export interface FetchOptions {
  provider: Provider;
  datasetId?: string;
  operation: string;
  timeoutMs?: number;
  maxAttempts?: number;
  correlationId?: string;
  longRunning?: boolean;
  signal?: AbortSignal;
  pinned?: boolean;
  maxResponseBytes?: number;
}

export interface FetchOutcome {
  ok: boolean;
  status: number;
  body: ArrayBuffer;
  bodyText?: string;
  latencyMs: number;
  attempts: number;
  errorDetail?: string;
}

export function isTransient(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 60);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1_000)), 60);
  return undefined;
}

export function redactProviderUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.pathname = url.pathname.replace(/(\/api\/area\/csv\/)[^/]+/i, '$1REDACTED');
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|authorization/i.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch { return '[invalid provider URL]'; }
}

async function logAttempt(
  provider: Provider, datasetId: string | undefined, operation: string, url: string,
  status: number, latencyMs: number, responseBytes: number | null, ok: boolean,
  errorDetail: string | null, correlationId: string | null,
) {
  if (isPrivateProvider()) return;
  try {
    await db.apiRequestLog.create({ data: {
      provider, datasetId: datasetId ?? null, operation,
      requestUrl: redactProviderUrl(url).slice(0, 900), paramsHash: stableHash(url),
      status, latencyMs: Math.round(latencyMs), responseBytes, ok,
      errorDetail: errorDetail ? errorDetail.slice(0, 300) : null, correlationId,
    } });
  } catch (err) {
    console.error('[provenance-log] failed:', err);
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function resilientFetch(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  const provider = opts.provider;
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 3, 1), 5);
  const timeoutMs = opts.timeoutMs ?? (opts.longRunning ? 60_000 : 20_000);
  if (opts.signal?.aborted) throw abortError();

  if (!isPrivateProvider()) {
    const circuit = await redisRuntime().getCircuit(`provider:${provider}`);
    if (circuit.open) {
      await logAttempt(provider, opts.datasetId, opts.operation, url, 503, 0, null, false,
        'circuit-breaker open (provider short-circuited after consecutive failures)', opts.correlationId ?? null);
      throw new ProviderUnavailableError(provider,
        `circuit breaker open after ${circuit.consecutiveFailures} consecutive failures; retry after ${Math.ceil(circuit.cooldownRemainingMs / 1_000)}s`);
    }
  }

  let lastOutcome: FetchOutcome | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    const started = Date.now();
    const timeoutController = new AbortController();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutController.signal])
      : timeoutController.signal;
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    let outcome: FetchOutcome;
    let retryAfterHeader: string | null = null;
    try {
      // Only provider transport belongs to the retry classifier. Redis and
      // provenance operations run after this catch so runtime outages can
      // never cause a successful or permanent provider call to be repeated.
      const res = opts.pinned
        ? await fetchPinnedPublicUrl(url, { signal, timeoutMs, maxResponseBytes: opts.maxResponseBytes, headers: { accept: '*/*' } })
        : await fetch(url, { signal, headers: { accept: '*/*' }, cache: 'no-store', redirect: 'manual' });
      retryAfterHeader = res.headers.get('retry-after');
      const body = await res.arrayBuffer();
      const latencyMs = Date.now() - started;
      outcome = {
        ok: res.ok, status: res.status, body, latencyMs, attempts: attempt,
        errorDetail: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
      };
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      const latencyMs = Date.now() - started;
      const timedOut = timeoutController.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      const detail = timedOut ? `timeout after ${timeoutMs}ms`
        : err instanceof Error ? err.message : 'network error';
      await logAttempt(provider, opts.datasetId, opts.operation, url, 0, latencyMs, null, false,
        detail, opts.correlationId ?? null);
      lastOutcome = { ok: false, status: 0, body: new ArrayBuffer(0), latencyMs, attempts: attempt, errorDetail: detail };
      if (attempt < maxAttempts) {
        const base = 500 * Math.pow(2, attempt - 1);
        await wait(Math.ceil(base / 2 + Math.random() * (base / 2)), opts.signal);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    await logAttempt(provider, opts.datasetId, opts.operation, url, outcome.status, outcome.latencyMs,
      outcome.body.byteLength, outcome.ok, outcome.ok ? null : outcome.errorDetail ?? null, opts.correlationId ?? null);
    if (outcome.ok) {
      await clearCircuit(provider);
      return outcome;
    }
    if (!isTransient(outcome.status)) {
      if (outcome.status !== 404) await tripCircuit(provider);
      return outcome;
    }
    lastOutcome = outcome;
    if (attempt < maxAttempts) {
      const retryAfter = parseRetryAfter(retryAfterHeader);
      const base = 500 * Math.pow(2, attempt - 1);
      const delay = retryAfter !== undefined
        ? retryAfter * 1_000
        : Math.ceil(base / 2 + Math.random() * (base / 2));
      await wait(delay, opts.signal);
    }
  }

  await tripCircuit(provider);
  if (lastOutcome) throw new ProviderUnavailableError(provider,
    `${lastOutcome.errorDetail ?? 'request failed'} after ${lastOutcome.attempts} attempts`);
  throw new ProviderUnavailableError(provider, 'unknown failure');
}
