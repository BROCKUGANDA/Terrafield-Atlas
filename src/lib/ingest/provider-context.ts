import { AsyncLocalStorage } from 'node:async_hooks';

const privacy = new AsyncLocalStorage<true>();

export const isPrivateProvider = () => privacy.getStore() === true;

/** Private coordinates must not enter shared provider caches or provenance logs. */
export function withPrivateProvider<T>(operation: () => T): T {
  return privacy.run(true, operation);
}