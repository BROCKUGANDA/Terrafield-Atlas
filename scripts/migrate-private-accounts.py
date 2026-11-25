import sqlite3
import sys
from pathlib import Path

database = Path(sys.argv[1])
migration = Path(sys.argv[2])
if not database.is_file():
    raise RuntimeError('Expected existing production SQLite database')
connection = sqlite3.connect(database, timeout=30)
backup_path = database.with_name(database.name + '.before-private-accounts-20261119')
if backup_path.exists():
    raise RuntimeError('Migration backup already exists; investigate before retrying')
with sqlite3.connect(backup_path) as backup:
    connection.backup(backup)
counts = {table: connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in ['Farm', 'FireWatchlist', 'SoilTest']}
connection.execute('PRAGMA foreign_keys=ON')
connection.executescript('BEGIN IMMEDIATE;\n' + migration.read_text() + '\nCOMMIT;')
for table, expected in counts.items():
    if connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] != expected:
        raise RuntimeError('Migration row count mismatch')
if connection.execute('PRAGMA foreign_key_check').fetchall():
    raise RuntimeError('Foreign-key integrity check failed')
connection.close()
print('Incremental account migration applied; original farm/watchlist/soil row counts and foreign keys verified. SQLite backup retained.')