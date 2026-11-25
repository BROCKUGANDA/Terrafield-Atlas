import { NextResponse } from 'next/server';
import { BodyTooLargeError, readBoundedText } from '@/lib/account-security';
import { rateLimit } from '@/lib/api/helpers';
import { getCorrelationId } from '@/lib/correlation';
import { exchangeClientCredentials } from '@/lib/oauth';
import { RedisUnavailableError } from '@/lib/redis';

/**
 * POST /api/v1/oauth/token — OAuth 2.0 client-credentials grant (RFC 6749 §4.4).
 *
 * Deliberately not wrapped in `apiHandler`: the endpoint authenticates the
 * client itself, so there is no session, same-origin, or tenant context. All
 * reads and writes use the owner connection until the token is resolved later.
 */

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const MAX_CLIENT_ID_LENGTH = 200;
const MAX_SECRET_LENGTH = 400;
const MAX_SCOPE_LENGTH = 1_000;

function oauthError(status: number, error: string, description: string, correlationId: string): NextResponse {
  const res = NextResponse.json({ error, error_description: description }, { status });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Correlation-Id', correlationId);
  return res;
}

export async function POST(req: Request): Promise<NextResponse> {
  const correlationId = getCorrelationId(req.headers.get('x-correlation-id'));
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== FORM_CONTENT_TYPE) {
    return oauthError(400, 'invalid_request', 'content type must be application/x-www-form-urlencoded', correlationId);
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readBoundedText(req));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return oauthError(400, 'invalid_request', 'request body is too large', correlationId);
    return oauthError(400, 'invalid_request', 'request body is not valid UTF-8 form data', correlationId);
  }

  const grantType = form.get('grant_type')?.trim() ?? '';
  const clientId = form.get('client_id')?.trim() ?? '';
  const clientSecret = form.get('client_secret') ?? '';
  const scope = form.get('scope')?.trim() ?? '';
  if (!grantType) return oauthError(400, 'invalid_request', 'grant_type is required', correlationId);
  if (grantType !== 'client_credentials') return oauthError(400, 'unsupported_grant_type', 'only client_credentials is supported', correlationId);
  if (!clientId || !clientSecret) return oauthError(400, 'invalid_request', 'client_id and client_secret are required', correlationId);
  if (clientId.length > MAX_CLIENT_ID_LENGTH || clientSecret.length > MAX_SECRET_LENGTH) {
    return oauthError(401, 'invalid_client', 'client authentication failed', correlationId);
  }
  if (scope.length > MAX_SCOPE_LENGTH) return oauthError(400, 'invalid_scope', 'requested scope is too long', correlationId);

  try {
    const limit = await rateLimit(`oauth:token:${clientId}`, { capacity: 30, refillPerMinute: 30 });
    if (!limit.allowed) {
      const res = oauthError(429, 'temporarily_unavailable', `too many token requests; retry after ${limit.retryAfterSec}s`, correlationId);
      res.headers.set('Retry-After', String(limit.retryAfterSec));
      return res;
    }

    const requestedScopes = scope ? scope.split(/\s+/).filter(Boolean) : undefined;
    const result = await exchangeClientCredentials({ clientId, clientSecret, scopes: requestedScopes });
    if (!result.ok) return oauthError(result.status, result.error, result.description, correlationId);

    const res = NextResponse.json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      scope: result.scope,
    });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Pragma', 'no-cache');
    res.headers.set('X-Correlation-Id', correlationId);
    return res;
  } catch (err) {
    if (err instanceof RedisUnavailableError) return oauthError(503, 'temporarily_unavailable', 'shared runtime is temporarily unavailable', correlationId);
    console.error('[oauth:token]', err);
    return oauthError(500, 'server_error', 'unexpected server error', correlationId);
  }
}
