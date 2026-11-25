/** Stable event names accepted by organization webhooks. */
export const WEBHOOK_EVENTS = [
  'farm.created',
  'farm.updated',
  'job.succeeded',
  'job.failed',
  'watchlist.digest',
  'subscription.updated',
  'organization.member.joined',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
