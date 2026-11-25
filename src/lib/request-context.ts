export interface RequestContext {
  farmId: string | null;
  lat?: number;
  lon?: number;
  inputHash?: string;
}

/** Fixed-order, collision-safe key for the selection that produced a result. */
export function requestContextKey(context: RequestContext): string {
  return JSON.stringify([
    context.farmId,
    context.lat ?? null,
    context.lon ?? null,
    context.inputHash ?? null,
  ]);
}

/** A late result may update the UI only when its submitted context is current. */
export function isRequestContextCurrent(submitted: RequestContext, current: RequestContext): boolean {
  return requestContextKey(submitted) === requestContextKey(current);
}
