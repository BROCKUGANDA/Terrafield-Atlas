import { db } from '@/lib/db';
import { appMetrics } from '@/lib/metrics';
import { redisRuntime } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Private-network Prometheus endpoint. Caddy explicitly denies public access. */
export async function GET() {
  const [{ queueMetrics }, { schedulerLeaseStatus }, { digestChannelStatus }] = await Promise.all([
    import('@/lib/jobs/runtime'),
    import('@/lib/scheduler'),
    import('@/lib/fires/digest-channel'),
  ]);
  const [database, redis, queue, scheduler, digest] = await Promise.allSettled([
    db.$queryRaw`SELECT 1`,
    redisRuntime().ping(),
    queueMetrics(),
    schedulerLeaseStatus(),
    Promise.resolve(digestChannelStatus()),
  ]);

  appMetrics.gauge('terrafield_database_up', database.status === 'fulfilled' ? 1 : 0);
  appMetrics.gauge('terrafield_redis_up', redis.status === 'fulfilled' ? 1 : 0);
  appMetrics.gauge('terrafield_process_uptime_seconds', process.uptime());
  appMetrics.gauge('terrafield_process_resident_memory_bytes', process.memoryUsage().rss);
  appMetrics.gauge('terrafield_scheduler_leader', scheduler.status === 'fulfilled' && scheduler.value.leader ? 1 : 0);
  appMetrics.gauge('terrafield_sse_subscribers', digest.status === 'fulfilled' ? digest.value.subscribers : 0);
  appMetrics.gauge('terrafield_sse_events_delivered_total', digest.status === 'fulfilled' ? digest.value.eventsDelivered : 0);

  if (queue.status === 'fulfilled') {
    appMetrics.gauge('terrafield_queue_waiting', queue.value.depth.waiting);
    appMetrics.gauge('terrafield_queue_active', queue.value.depth.active);
    appMetrics.gauge('terrafield_queue_failed', queue.value.depth.failed);
    appMetrics.gauge('terrafield_queue_oldest_job_age_seconds', queue.value.oldestJobAgeSec ?? 0);
    appMetrics.gauge('terrafield_queue_workers', queue.value.workers.length);
    appMetrics.gauge('terrafield_jobs_retries', queue.value.retries);
    appMetrics.gauge('terrafield_jobs_failures_24h', queue.value.failures);
    appMetrics.gauge('terrafield_jobs_dead_lettered', queue.value.deadLettered);
    appMetrics.gauge('terrafield_jobs_running', queue.value.running);
  }

  return new Response(appMetrics.render(), {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  });
}
