import { api, ApiRequestError, type JobAccepted, type JobDetail, type JobStatus } from '@/lib/api-client';

export type JobTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'dead-lettered';

const TERMINAL_STATUSES = new Set<JobTerminalStatus>(['succeeded', 'failed', 'cancelled', 'dead-lettered']);

export class JobExecutionError extends ApiRequestError {
  readonly jobId: string;
  readonly terminalStatus: JobTerminalStatus;

  constructor(input: {
    jobId: string;
    status: JobTerminalStatus;
    message: string;
    correlationId?: string;
  }) {
    super(input.status === 'cancelled' ? 499 : 500, {
      code: input.status === 'succeeded' ? 'JOB_RESULT_MISSING' : `JOB_${input.status.replaceAll('-', '_').toUpperCase()}`,
      message: input.message,
      correlationId: input.correlationId,
    });
    this.name = 'JobExecutionError';
    this.jobId = input.jobId;
    this.terminalStatus = input.status;
  }
}

export interface WaitForJobOptions {
  /** Initial poll interval; grows gently to avoid hammering the status endpoint. */
  pollIntervalMs?: number;
  /** Overall client-side budget. The server-side job deadline remains authoritative. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { status: JobStatus; progressNote: string | null; attempts: number }) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve a durable job to its terminal result.
 *
 * POST endpoints answer 202 with a job pointer. This helper polls the
 * authoritative PostgreSQL job row and returns only a successful result; a
 * failed, cancelled, dead-lettered or malformed job never becomes UI success.
 */
export async function waitForJob<T>(
  accepted: JobAccepted,
  options: WaitForJobOptions = {},
): Promise<T> {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
  const timeoutMs = Math.max(pollIntervalMs, options.timeoutMs ?? 20 * 60_000);
  const deadline = Date.now() + timeoutMs;
  let interval = pollIntervalMs;

  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    let detail: JobDetail<unknown>;
    try {
      detail = await api.job<unknown>(accepted.jobId, options.signal);
    } catch (error) {
      // Preserve API/auth/rate-limit failures. A transient status-read failure
      // is retried by the shared GET transport before reaching this point.
      throw error;
    }

    const status = detail.job.status;
    options.onProgress?.({
      status,
      progressNote: detail.job.progressNote,
      attempts: detail.job.attempts,
    });

    if (TERMINAL_STATUSES.has(status as JobTerminalStatus)) {
      const terminal = status as JobTerminalStatus;
      if (terminal === 'succeeded') {
        if (detail.result === null || detail.result === undefined) {
          throw new JobExecutionError({
            jobId: accepted.jobId,
            status: terminal,
            message: 'The job succeeded but returned no result payload.',
            correlationId: detail.job.correlationId ?? undefined,
          });
        }
        return detail.result as T;
      }
      throw new JobExecutionError({
        jobId: accepted.jobId,
        status: terminal,
        message: detail.job.error ?? `The job ended with status ${terminal}.`,
        correlationId: detail.job.correlationId ?? undefined,
      });
    }

    await sleep(interval, options.signal);
    interval = Math.min(Math.round(interval * 1.35), 5_000);
  }

  throw new JobExecutionError({
    jobId: accepted.jobId,
    status: 'failed',
    message: `The console stopped waiting after ${Math.round(timeoutMs / 60_000)} minute(s). The durable job may still be running; inspect its job URL.`,
    correlationId: accepted.correlationId,
  });
}

/** Create an API-compatible error for callers that render ApiRequestError details. */
export function asApiRequestError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  if (error instanceof JobExecutionError) {
    return new ApiRequestError(error.terminalStatus === 'cancelled' ? 499 : 500, {
      code: error.code,
      message: error.message,
      correlationId: error.correlationId,
    });
  }
  return new ApiRequestError(0, {
    code: error instanceof Error && error.name === 'AbortError' ? 'ABORTED' : 'NETWORK',
    message: error instanceof Error ? error.message : 'Unexpected job execution error.',
  });
}
