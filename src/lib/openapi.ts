const scopeNames = ['farms.read', 'observations.read', 'analyses.read', 'reports.read', 'sources.read'] as const;

const oauthScopes = Object.fromEntries(scopeNames.map((scope) => [scope, `Read access to ${scope.split('.')[0]}`]));

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'TerraField Atlas Developer API',
    version: '1.1.0',
    description: 'Permission-scoped, tenant-aware access to farms, observations, analyses, reports, and data sources. Authenticate with a console-issued API key or an OAuth 2.0 client-credentials access token. No NASA endorsement is implied.',
  },
  servers: [{ url: 'https://terrafieldatlas.us/api/v1', description: 'Production' }, { url: '/api/v1', description: 'Same-origin TerraField API' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/developer/farms': { get: { summary: 'List authorized farms', parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }], responses: { '200': { description: 'Farm page' }, '401': { description: 'Invalid API key or access token' }, '402': { description: 'Plan quota reached' }, '429': { description: 'Rate limited' } } } },
    '/developer/observations': { get: { summary: 'List stored real observations', parameters: [{ name: 'farmId', in: 'query', schema: { type: 'string' } }, { name: 'variable', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000 } }], responses: { '200': { description: 'Observation page' } } } },
    '/developer/analyses': { get: { summary: 'List authorized trend analyses', responses: { '200': { description: 'Analysis page' } } } },
    '/developer/reports': { get: { summary: 'List persisted report records', responses: { '200': { description: 'Report page' } } } },
    '/developer/sources': { get: { summary: 'List the governed data-source register', responses: { '200': { description: 'Source register' } } } },
    '/oauth/token': {
      post: {
        summary: 'Exchange client credentials for an access token',
        description: 'OAuth 2.0 client-credentials grant (RFC 6749 §4.4). Access tokens are opaque, expire after 3600 seconds, and carry the scopes frozen at issuance.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['grant_type', 'client_id', 'client_secret'],
                properties: {
                  grant_type: { type: 'string', const: 'client_credentials' },
                  client_id: { type: 'string' },
                  client_secret: { type: 'string', format: 'password' },
                  scope: { type: 'string', description: 'Optional space-delimited subset of the scopes granted to the client.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Access token issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthToken' } } } },
          '400': { description: 'invalid_request, unsupported_grant_type, or invalid_scope', content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthError' } } } },
          '401': { description: 'invalid_client', content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthError' } } } },
          '429': { description: 'Rate limited per client id' },
        },
      },
    },
    '/organizations/{id}/oauth-clients': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'List OAuth clients (secrets are never returned)',
        security: [{ sessionCookie: [] }],
        responses: { '200': { description: 'OAuth client list' }, '403': { description: 'org.manage permission required' } },
      },
      post: {
        summary: 'Create an OAuth client; the secret is returned exactly once',
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'scopes'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 80 },
                  scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: scopeNames } },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Client created and secret disclosed once', content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthClientSecret' } } } },
          '403': { description: 'org.manage permission required' },
        },
      },
    },
    '/organizations/{id}/oauth-clients/{clientId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'clientId', in: 'path', required: true, schema: { type: 'string' }, description: 'Record id or public tf_oauth_... identifier.' },
      ],
      delete: {
        summary: 'Revoke an OAuth client and every access token it issued',
        security: [{ sessionCookie: [] }],
        responses: { '200': { description: 'Client revoked' }, '404': { description: 'OAuth client not found in this organization' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'TerraField API key or OAuth access token', description: 'Send `tf_live_...` API keys or `tf_oauth_at_...` access tokens. Required scopes: farms.read, observations.read, analyses.read, reports.read, sources.read.' },
      oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/api/v1/oauth/token', scopes: oauthScopes } } },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Secure-next-auth.session-token', description: 'Browser session used by the console to manage OAuth clients.' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, correlationId: { type: 'string' } } } } },
      OAuthError: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, error_description: { type: 'string' } } },
      OAuthToken: {
        type: 'object',
        required: ['access_token', 'token_type', 'expires_in', 'scope'],
        properties: {
          access_token: { type: 'string' },
          token_type: { type: 'string', const: 'Bearer' },
          expires_in: { type: 'integer', const: 3600 },
          scope: { type: 'string', description: 'Space-delimited granted scopes.' },
        },
      },
      OAuthClient: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          clientId: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string', enum: scopeNames } },
          active: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      OAuthClientSecret: {
        type: 'object',
        properties: {
          client: { $ref: '#/components/schemas/OAuthClient' },
          client_secret: { type: 'string', description: 'Shown only on the initial creation response.' },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;
