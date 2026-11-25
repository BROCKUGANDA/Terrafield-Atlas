import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test.each([
  ['--backup', '-backup.db'],
  ['--backup', 'outputs/-backup.db'],
  ['--target-snapshot', '-snapshot.dump'],
  ['--target-snapshot', 'outputs/-snapshot.dump'],
] as const)('cutover rejects dash-prefixed %s before freeze without creating output', (flag, output) => {
  const workspace = mkdtempSync(join(tmpdir(), 'terrafield cutover preflight '));
  workspaces.push(workspace);
  mkdirSync(join(workspace, 'artifact'));
  mkdirSync(join(workspace, 'outputs'));
  writeFileSync(join(workspace, 'source.db'), 'preflight fixture');
  writeFileSync(join(workspace, 'runtime.env'), 'DATABASE_URL=file:previous.db\n');
  for (const hook of ['freeze', 'activate', 'restart']) {
    writeFileSync(join(workspace, `${hook}.sh`), `#!/bin/sh\nset -eu\nprintf '%s\\n' '${hook}' > '${hook}.marker'\n`);
  }
  const commandBin = join(workspace, 'bin');
  mkdirSync(commandBin);
  const commands = {
    bun: 'if [ -n "${BACKUP_TMP:-}" ]; then printf backup > "$BACKUP_TMP"; fi\n',
    sqlite3: 'printf "ok\\n"\n',
    sha256sum: `printf '%s\\n' '${'a'.repeat(64)}'\n`,
    pg_dump: 'for arg do case "$arg" in --file=*) printf snapshot > "${arg#--file=}" ;; esac; done\n',
    curl: '',
  };
  for (const [command, body] of Object.entries(commands)) {
    writeFileSync(join(commandBin, command), `#!/bin/sh\nset -eu\n${body}`);
  }
  const filesBefore = readdirSync(workspace).sort();
  const args = [
    resolve('deploy/scripts/cutover.sh'),
    '--source', 'source.db',
    '--target-url', 'postgresql://postgres@127.0.0.1:1/disposable',
    '--backup', 'backup.db',
    '--target-snapshot', 'snapshot.dump',
    '--artifact', 'artifact',
    '--env-file', 'runtime.env',
    '--freeze-hook', 'freeze.sh',
    '--activate-hook', 'activate.sh',
    '--restart-hook', 'restart.sh',
    '--readiness-url', 'http://127.0.0.1:1/ready',
  ];
  args[args.indexOf(flag) + 1] = output;

  const result = spawnSync('sh', args, {
    cwd: workspace,
    env: { ...process.env, PATH: `${commandBin}${delimiter}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported.*(?:backup|snapshot)/i);
  expect(result.stdout).not.toContain('freezing writes');
  expect(existsSync(join(workspace, 'freeze.marker'))).toBe(false);
  expect(existsSync(join(workspace, output))).toBe(false);
  expect(readdirSync(workspace).sort()).toEqual(filesBefore);
});
