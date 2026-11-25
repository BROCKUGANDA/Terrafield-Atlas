export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'TerraField Atlas Developer API',
    version: '1.0.0',
    description: 'Permission-scoped, tenant-aware access to farms, observations, analyses, reports, and data sources. No NASA endorsement is implied.',
  },
  servers: [{ url: '/api/v1/developer', description: 'Same-origin developer API' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/farms': { get: { summary: 'List authorized farms', parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }], responses: { '200': { description: 'Farm page' }, '401': { description: 'Invalid API key' }, '402': { description: 'Plan quota reached' }, '429': { description: 'Rate limited' } } } },
    '/observations': { get: { summary: 'List stored real observations', parameters: [{ name: 'farmId', in: 'query', schema: { type: 'string' } }, { name: 'variable', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000 } }], responses: { '200': { description: 'Observation page' } } } },
    '/analyses': { get: { summary: 'List authorized trend analyses', responses: { '200': { description: 'Analysis page' } } } },
    '/reports': { get: { summary: 'List persisted report records', responses: { '200': { description: 'Report page' } } } },
    '/sources': { get: { summary: 'List the governed data-source register', responses: { '200': { description: 'Source register' } } } },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'TerraField API key', description: 'Keys are created in the console and shown once. Required scopes: farms.read, observations.read, analyses.read, reports.read, sources.read.' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, correlationId: { type: 'string' } } } } },
    },
  },
} as const;
