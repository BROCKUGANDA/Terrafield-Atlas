import { db } from '@/lib/db';
import { stableHash } from '@/lib/cache';

/**
 * Resilient HTTP client for external data providers.
 *
 * Reliability contract (Section 12 of the product spec):
 * - Exponential backoff with jitter, only for TRANSIENT failures
 *   (network errors, timeouts, HTTP 429, 5xx).
 * - Permanent failures (other 4xx) fail fast: retrying an invalid request
 *   would waste the provider's quota and ours.
 * - Every attempt is written to the ApiRequestLog provenance ledger.
 * - Circuit breaker per provider: after N consecutive failures the provider
 *   is short-circuited for a cooldown window instead of hammering it.
 */

export type Provider = 'NASA_POWER' | 'GIBS' | 'SOILGRIDS' | 'FIRMS' | 'EONET';

export class ProviderUnavailableError extends Error {
  constructor(provider: Provider, detail: string) {
    super(`Provider ${provider} unavailable: ${detail}`);
    this.name = 'ProviderUnavailableError';
  }
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

const circuits = new Map<Provider, CircuitState>();
const FAILURE_THRESHOLD = 4;
const COOLDOWN_MS = 60_000;

export function circuitStatus() {
  const now = Date.now();
  return (['NASA_POWER', 'GIBS', 'SOILGRIDS', 'FIRMS', 'EONET'] as Provider[]).map((p) => {
    const c = circuits.get(p);
    return {
      provider: p,
      consecutiveFailures: c?.consecutiveFailures ?? 0,
      open: !!c && c.openUntil > now,
      cooldownRemainingMs: c ? Math.max(0, c.openUntil - now) : 0,
    };
  });
}

function tripCircuit(provider: Provider) {
  const c = circuits.get(provider) ?? { consecutiveFailures: 0, openUntil: 0 };
  c.consecutiveFailures++;
  if (c.consecutiveFailures >= FAILURE_THRESHOLD) {
    c.openUntil = Date.now() + COOLDOWN_MS;
  }
  circuits.set(provider, c);
}

function clearCircuit(provider: Provider) {
  circuits.set(provider, { consecutiveFailures: 0, openUntil: 0 });
}

export interface FetchOptions {
  provider: Provider;
  datasetId?: string;
  operation: string;
  timeoutMs?: number;
  maxAttempts?: number;
  correlationId?: string;
  /** Requests expected to exceed the default budget (large archives). */
  longRunning?: boolean;
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

async function logAttempt(
  provider: Provider,
  datasetId: string | undefined,
  operation: string,
  url: string,
  status: number,
  latencyMs: number,
  responseBytes: number | null,
  ok: boolean,
  errorDetail: string | null,
  correlationId: string | null,
) {
  try {
    await db.apiRequestLog.create({
      data: {
        provider,
        datasetId: datasetId ?? null,
        operation,
        requestUrl: url.length > 900 ? url.slice(0, 900) : url,
        paramsHash: stableHash(url),
        status,
        latencyMs: Math.round(latencyMs),
        responseBytes,
        ok,
        errorDetail: errorDetail ? errorDetail.slice(0, 300) : null,
        correlationId,
      },
    });
  } catch (err) {
    // Provenance logging must never break the request path.
    console.error('[provenance-log] failed:', err);
  }
}

/**
 * Fetch with retry/backoff/circuit-breaker + provenance logging.
 * Returns the raw body as ArrayBuffer plus outcome metadata; callers parse.
 */
export async function resilientFetch(
  url: string,
  opts: FetchOptions,
): Promise<FetchOutcome> {
  const provider = opts.provider;
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? (opts.longRunning ? 60_000 : 20_000);

  const circuit = circuits.get(provider);
  if (circuit && circuit.openUntil > Date.now()) {
    await logAttempt(
      provider, opts.datasetId, opts.operation, url, 503, 0, null, false,
      'circuit-breaker open (provider short-circuited after consecutive failures)',
      opts.correlationId ?? null,
    );
    throw new ProviderUnavailableError(
      provider,
      `circuit breaker open after ${circuit.consecutiveFailures} consecutive failures; retry after ${Math.round((circuit.openUntil - Date.now()) / 1000)}s`,
    );
  }

  let lastOutcome: FetchOutcome | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: '*/*' },
        cache: 'no-store',
      });
      const body = await res.arrayBuffer();
      const latencyMs = Date.now() - started;
      const outcome: FetchOutcome = {
        ok: res.ok,
        status: res.status,
        body,
        latencyMs,
        attempts: attempt,
        errorDetail: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
      };
      await logAttempt(
        provider, opts.datasetId, opts.operation, url, res.status, latencyMs,
        body.byteLength, res.ok, res.ok ? null : outcome.errorDetail ?? null,
        opts.correlationId ?? null,
      );
      if (res.ok) {
        clearCircuit(provider);
        return outcome;
      }
      if (!isTransient(res.status)) {
        // Permanent client error: do not retry.
        tripCircuit(provider);
        return outcome;
      }
      lastOutcome = outcome;
    } catch (err) {
      const latencyMs = Date.now() - started;
      const detail =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : 'network error';
      await logAttempt(
        provider, opts.datasetId, opts.operation, url, 0, latencyMs, null, false,
        detail, opts.correlationId ?? null,
      );
      lastOutcome = {
        ok: false, status: 0, body: new ArrayBuffer(0), latencyMs,
        attempts: attempt, errorDetail: detail,
      };
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) {
      // Exponential backoff with full jitter: 500ms * 2^(n-1) ± random.
      const base = 500 * Math.pow(2, attempt - 1);
      const delay = base / 2 + Math.random() * (base / 2);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  tripCircuit(provider);
  if (lastOutcome) {
    throw new ProviderUnavailableError(
      provider,
      `${lastOutcome.errorDetail ?? 'request failed'} after ${lastOutcome.attempts} attempts`,
    );
  }
  throw new ProviderUnavailableError(provider, 'unknown failure');
}
