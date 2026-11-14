import { randomUUID } from 'crypto';

/**
 * Correlation IDs propagate through every API request and provenance record.
 * Uses the ambient request header when available (gateway-injected), otherwise
 * generates a UUID. Format: 8-4-4-4-12 hex or gateway token, truncated to 64.
 */
export function getCorrelationId(headerValue: string | null | undefined): string {
  const raw = headerValue?.trim();
  if (raw && /^[A-Za-z0-9\-_]{4,64}$/.test(raw)) return raw;
  return randomUUID();
}
