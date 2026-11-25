#!/usr/bin/env bun
import { validateMigration } from './migrate-sqlite-to-postgres';
export { validateMigration } from './migrate-sqlite-to-postgres';

async function main(): Promise<void> {
  const [sourceUrl, targetUrl, ...rest] = process.argv.slice(2);
  if (!sourceUrl || !targetUrl || rest.length) {
    console.error('Usage: bun scripts/validate-migration.ts <file:source.db> <postgresql://target>');
    process.exit(2);
  }
  if (!targetUrl.startsWith('postgresql://') && !targetUrl.startsWith('postgres://')) {
    throw new Error('targetUrl must be an explicit PostgreSQL URL');
  }
  const tables = await validateMigration(sourceUrl, targetUrl);
  console.log(JSON.stringify({ valid: true, tables }, null, 2));
}
if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
