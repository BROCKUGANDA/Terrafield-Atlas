interface SchedulerDiagnostics {  kind: string;
  enabled: boolean;
  disabledByEnv: boolean;
  tickEverySec: number;
  maxRunsPerTick: number;
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTick: { tickAt: string; ran: number; dueCount: number } | null;
  ticksFired: number;
  ticksSkippedBusy: number;
  consecutiveFailedRuns: number;
  scheduledWatchlists: number;
  nextDueAt: string | null;
}

export function publicSchedulerDiagnostics<T extends SchedulerDiagnostics>(value: T) {
  return {
    kind: value.kind,
    enabled: value.enabled,
    disabledByEnv: value.disabledByEnv,
    tickEverySec: value.tickEverySec,
    maxRunsPerTick: value.maxRunsPerTick,
    running: value.running,
    startedAt: value.startedAt,
    lastTickAt: value.lastTickAt,
    lastTick: value.lastTick ? {
      tickAt: value.lastTick.tickAt,
      ran: value.lastTick.ran,
      dueCount: value.lastTick.dueCount,
      runs: [],
    } : null,
    ticksFired: value.ticksFired,
    ticksSkippedBusy: value.ticksSkippedBusy,
    consecutiveFailedRuns: value.consecutiveFailedRuns,
    scheduledWatchlists: value.scheduledWatchlists,
    nextDueAt: value.nextDueAt,
    dueNow: [],
    note: 'Aggregate scheduler health only. Watchlist identities and run metadata are private.',
  };
}

/** Explicit allowlists keep future operator-only diagnostic fields off the public wire. */
export function publicCacheDiagnostics(value: { liveEntries: number; expiredEntries: number; maxEntries: number }) {
  return { liveEntries: value.liveEntries, expiredEntries: value.expiredEntries, maxEntries: value.maxEntries };
}

export function publicCircuitDiagnostics(value: { open: boolean; consecutiveFailures: number }[]) {
  return {
    total: value.length,
    open: value.filter((circuit) => circuit.open).length,
    withFailures: value.filter((circuit) => circuit.consecutiveFailures > 0).length,
  };
}

interface PublicExitDiagnostics {
  state: string;
  attempts?: number;
  delivered?: number;
  failed?: number;
  sent?: number;
}

export function publicDigestDiagnostics(value: {
  enabled: boolean;
  maxClients: number;
  subscribers: number;
  connectionsOpened: number;
  eventsDelivered: number;
  exits: { webhook: PublicExitDiagnostics; email: PublicExitDiagnostics };
}) {
  const exit = (details: PublicExitDiagnostics) => ({
    state: details.state,
    attempts: details.attempts ?? details.sent ?? 0,
    delivered: details.delivered ?? details.sent ?? 0,
    failed: details.failed ?? 0,
  });
  return {
    enabled: value.enabled,
    maxClients: value.maxClients,
    subscribers: value.subscribers,
    connectionsOpened: value.connectionsOpened,
    eventsDelivered: value.eventsDelivered,
    exits: { webhook: exit(value.exits.webhook), email: exit(value.exits.email) },
  };
}

export function publicEmailDiagnostics(value: PublicExitDiagnostics) {
  return { state: value.state, sent: value.sent ?? 0, failed: value.failed ?? 0 };
}

export function publicExperimentDiagnostics(value: {
  key: string;
  active: boolean;
  variants: { variant: string; exposures: number; outcomes: number }[];
}[]) {
  return value.map((experiment) => ({
    key: experiment.key,
    active: experiment.active,
    variants: experiment.variants.map((variant) => ({
      variant: variant.variant,
      exposures: variant.exposures,
      outcomes: variant.outcomes,
    })),
  }));
}
