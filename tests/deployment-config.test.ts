import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('private Compose deployment', () => {
  test('database, Redis and monitoring ports are not public', () => {
    const compose = read('compose.yaml');
    for (const service of ['postgres:', 'redis:', 'prometheus:', 'grafana:']) {
      const start = compose.indexOf(`  ${service}`);
      const next = compose.indexOf('\n  ', start + 3);
      const block = compose.slice(start, next === -1 ? undefined : next);
      expect(block).not.toMatch(/\n\s+ports:/);
    }
    expect(compose).toContain('internal: true');
  });

  test('Caddy has fixed upstreams and no query-controlled transform port', () => {
    const caddy = read('deploy/caddy/Caddyfile');
    expect(caddy).toContain('reverse_proxy web:3000 web-secondary:3000');
    expect(caddy).not.toContain('XTransformPort');
    expect(caddy).not.toContain('{query.');
    expect(caddy).toContain('respond @metrics 403');
  });

  test('Compose defines the full production service topology', () => {
    const compose = read('compose.yaml');
    for (const service of ['postgres:', 'redis:', 'migrate:', 'web:', 'web-secondary:', 'worker:', 'scheduler:', 'outbox:', 'caddy:', 'prometheus:', 'grafana:']) {
      expect(compose).toContain(`  ${service}`);
    }
    expect(compose).toContain('postgis/postgis:16-3.4');
    expect(compose).toContain('prisma migrate deploy && bun run db:seed');
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "5"');
  });

  test('web replicas share database and Redis configuration', () => {
    const compose = read('compose.yaml');
    expect(compose).toContain('DATABASE_URL: postgresql://');
    expect(compose).toContain('REDIS_URL: redis://redis:6379');
    expect((compose.match(/<<: \*app-env/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(compose).toContain('x-app-env: &app-env');
  });

  test('release automation backs up and gates readiness before success', () => {
    const release = read('deploy/scripts/release.sh');
    expect(release).toContain('./deploy/backup.sh');
    expect(release).toContain('/api/v1/readyz');
    expect(release).toContain('pg_restore');
    expect(release).toContain('rollback()');
  });

  test('monitoring assets are valid JSON and include required alerts', () => {
    const dashboard = JSON.parse(read('deploy/grafana/provisioning/dashboards/dashboard.json')) as { panels: unknown[] };
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);
    const alerts = read('deploy/alert-rules.yml');
    for (const name of ['TerrafieldDatabaseDown', 'TerrafieldRedisDown', 'TerrafieldSchedulerLeaderMissing', 'TerrafieldWorkersMissing', 'TerrafieldQueueOldestJobAge']) {
      expect(alerts).toContain(name);
    }
  });

  test('systemd deployment never pins the runtime to the legacy SQLite file', () => {
    const unit = read('deploy/systemd/terrafield.service');
    expect(unit).toContain('EnvironmentFile=/home/ubuntu/ai-azimara-terrafield/.env');
    expect(unit).not.toMatch(/Environment=DATABASE_URL/);
    for (const dropIn of ['deploy/systemd/terrafield.service.d/10-block-storage.conf']) {
      expect(read(dropIn)).not.toMatch(/DATABASE_URL/);
    }
    for (const stale of ['deploy/systemd/terrafield.service.d/20-block-database.conf']) {
      expect(() => read(stale)).toThrow();
    }
  });

  test('host deploy script backs up, gates readiness and rolls back', () => {
    const deploy = read('scripts/deploy-vps.sh');
    expect(deploy).toContain('pg_dump');
    expect(deploy).toContain('/api/v1/readyz');
    expect(deploy).toContain('db:migrate:deploy');
    expect(deploy).toContain('rollback()');
    expect(deploy).toContain('systemctl restart');
    expect(deploy).toContain('--frozen-lockfile');
  });

  test('production web requests run under the RLS app role', () => {
    const unit = read('deploy/systemd/terrafield.service');
    expect(unit).toContain('EnvironmentFile=-/home/ubuntu/ai-azimara-terrafield/.env.tenant');
    const deploy = read('scripts/deploy-vps.sh');
    expect(deploy).toContain('TENANT_DATABASE_URL=');
    expect(deploy).toContain('role%3Dterrafield_app');
    expect(deploy).toContain('install -m 644 deploy/systemd/terrafield.service');
  });

  test('host observability binds loopback and scrapes the systemd app', () => {
    const compose = read('deploy/host-monitoring/compose.yaml');
    expect(compose).toContain('prom/prometheus');
    expect(compose).toContain('grafana/grafana');
    expect(compose).toContain('127.0.0.1:9090:9090');
    expect(compose).toContain('127.0.0.1:3001:3000');
    const scrape = read('deploy/host-monitoring/prometheus.yml');
    expect(scrape).toContain('host.docker.internal:3011');
    expect(scrape).toContain('/api/v1/metrics');
    const deploy = read('scripts/deploy-vps.sh');
    expect(deploy).toContain('deploy/host-monitoring/compose.yaml');
  });
});
