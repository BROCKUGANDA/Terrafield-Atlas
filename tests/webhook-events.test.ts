import { expect, test } from 'bun:test';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

test('advertised webhook events match the watchlist producer contract', () => {
  expect(WEBHOOK_EVENTS).toContain('watchlist.digest');
  expect(WEBHOOK_EVENTS).not.toContain('watchlist.alert');
});
