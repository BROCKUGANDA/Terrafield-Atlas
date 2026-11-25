const preconnect = globalThis.fetch.preconnect;

type FetchImplementation = (...args: Parameters<typeof fetch>) => Promise<Response>;

/** Make an async fetch test double satisfy Bun's fetch namespace type. */
export function createFetchMock(implementation: FetchImplementation): typeof fetch {
  return Object.assign(implementation, { preconnect });
}
