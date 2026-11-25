import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-call provider attribution.
 *
 * `private` keeps a call out of shared caches, circuits and single-flight
 * refreshes. `organizationId` lets the provenance ledger record that a private
 * provider call happened for an organization without persisting coordinates or
 * raw response detail. Anonymous private calls stay unlogged.
 */
export interface ProviderAttribution {
  private: boolean;
  organizationId: string | null;
}

const attribution = new AsyncLocalStorage<ProviderAttribution>();

export const providerAttribution = (): ProviderAttribution | null => attribution.getStore() ?? null;

export const isPrivateProvider = () => attribution.getStore()?.private === true;

/** Private coordinates must not enter shared provider caches or provenance logs. */
export function withPrivateProvider<T>(operation: () => T, organizationId?: string | null): T {
  return attribution.run({ private: true, organizationId: organizationId ?? null }, operation);
}
