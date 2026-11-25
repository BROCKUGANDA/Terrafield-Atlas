-- Secrets must never be recoverable from durable idempotency replay records.
-- Redact records created before the application stopped persisting one-time
-- webhook signing secrets and API keys. Operators must still rotate any secret
-- that may have been exposed while the vulnerable version was deployed.
UPDATE "IdempotencyRecord"
SET "responseRef" = jsonb_set(
  ("responseRef"::jsonb) #- '{body,secret}',
  '{body,note}',
  '"Secret was shown only on the initial creation response."'::jsonb,
  true
)::text
WHERE route IN ('/api/v1/webhooks', '/api/v1/api-keys')
  AND ("responseRef"::jsonb #> '{body,secret}') IS NOT NULL;
