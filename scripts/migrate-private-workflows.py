"""Add durable private-workflow ownership to an existing SQLite DB, without rebuilding tables.

Usage: python scripts/migrate-private-workflows.py /absolute/path/to/database.db
Stop writers and take a backup first. This script neither creates a DB nor deploys code.
"""

import json
import sqlite3
import sys
from pathlib import Path


def migrate(path):
    path = Path(path).resolve(strict=True)
    conn = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=30)
    try:
        conn.execute('PRAGMA foreign_keys = ON')
        conn.execute('BEGIN IMMEDIATE')
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        quote = lambda name: '"' + name.replace('"', '""') + '"'
        counts = {t: conn.execute(f'SELECT COUNT(*) FROM {quote(t)}').fetchone()[0] for t in tables}
        for table in ('EnvironmentalObservation', 'TrendAnalysis', 'ProcessingJob'):
            columns = {r[1] for r in conn.execute(f'PRAGMA table_info({quote(table)})')}
            if not columns:
                raise RuntimeError(f'Missing prerequisite table: {table}')
            if 'ownerId' not in columns:
                conn.execute(f'ALTER TABLE {quote(table)} ADD COLUMN "ownerId" TEXT')
                if table != 'ProcessingJob':
                    conn.execute(f'UPDATE {quote(table)} SET "ownerId" = (SELECT "ownerId" FROM "Farm" WHERE "Farm"."id" = {quote(table)}."farmId")')
                else:
                    for job_id, params in conn.execute('SELECT id, params FROM ProcessingJob').fetchall():
                        owner = None
                        try:
                            refs = json.loads(params)
                            if not isinstance(refs, dict):
                                raise ValueError('invalid params')
                            for key, resource in (('farmId', 'Farm'), ('watchlistId', 'FireWatchlist')):
                                ref = refs.get(key)
                                if ref is None:
                                    continue
                                if not isinstance(ref, str):
                                    raise ValueError('invalid reference')
                                row = conn.execute(f'SELECT ownerId FROM {quote(resource)} WHERE id = ?', (ref,)).fetchone()
                                if row is None:
                                    raise ValueError('missing reference')
                                if row[0] is not None:
                                    if owner is not None and owner != row[0]:
                                        raise ValueError('conflicting owners')
                                    owner = row[0]
                        except (ValueError, TypeError):
                            owner = 'unresolved:legacy'
                        conn.execute('UPDATE ProcessingJob SET ownerId = ? WHERE id = ?', (owner, job_id))
        columns = {r[1] for r in conn.execute('PRAGMA table_info("EnvironmentalObservation")')}
        if 'namespace' not in columns:
            conn.execute("ALTER TABLE EnvironmentalObservation ADD COLUMN namespace TEXT NOT NULL DEFAULT 'public'")
            conn.execute("UPDATE EnvironmentalObservation SET namespace = 'farm:' || farmId WHERE ownerId IS NOT NULL AND farmId IS NOT NULL")
            conn.execute("UPDATE EnvironmentalObservation SET namespace = 'orphan:' || id WHERE ownerId IS NOT NULL AND farmId IS NULL")
        conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS EnvironmentalObservation_namespace_lat_lon_variable_obsDate_key ON EnvironmentalObservation(namespace, lat, lon, variable, obsDate)')
        conn.execute('DROP INDEX IF EXISTS EnvironmentalObservation_lat_lon_variable_obsDate_key')
        conn.execute('CREATE INDEX IF NOT EXISTS EnvironmentalObservation_ownerId_idx ON EnvironmentalObservation(ownerId)')
        for table, count in counts.items():
            if conn.execute(f'SELECT COUNT(*) FROM {quote(table)}').fetchone()[0] != count:
                raise RuntimeError(f'Row count changed: {table}')
        if conn.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('foreign_key_check failed; migration rolled back')
        conn.commit()
        print('Private workflows migration complete; all original table counts and foreign keys verified.')
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python scripts/migrate-private-workflows.py DATABASE_PATH')
    migrate(sys.argv[1])