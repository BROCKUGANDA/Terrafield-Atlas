import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('private_migration', ROOT / 'scripts' / 'migrate-private-workflows.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def fixture(self, path):
        conn = sqlite3.connect(path)
        conn.executescript('''
            PRAGMA foreign_keys=ON;
            CREATE TABLE Farm(id TEXT PRIMARY KEY, ownerId TEXT);
            CREATE TABLE FireWatchlist(id TEXT PRIMARY KEY, ownerId TEXT);
            CREATE TABLE EnvironmentalObservation(id TEXT PRIMARY KEY, farmId TEXT REFERENCES Farm(id) ON DELETE SET NULL, lat REAL, lon REAL, variable TEXT, obsDate TEXT, value REAL);
            CREATE UNIQUE INDEX EnvironmentalObservation_lat_lon_variable_obsDate_key ON EnvironmentalObservation(lat,lon,variable,obsDate);
            CREATE TABLE TrendAnalysis(id TEXT PRIMARY KEY, farmId TEXT REFERENCES Farm(id) ON DELETE SET NULL, resultJson TEXT);
            CREATE TABLE ProcessingJob(id TEXT PRIMARY KEY, params TEXT, resultRef TEXT);
            CREATE TABLE Unrelated(id TEXT PRIMARY KEY, payload BLOB);
            INSERT INTO Farm VALUES ('a','owner-a'),('b','owner-b'),('public',NULL);
            INSERT INTO FireWatchlist VALUES ('watch','owner-a'),('other','owner-b');
            INSERT INTO EnvironmentalObservation VALUES ('private','a',1,2,'T2M','2024-01-01',21),('public','public',3,4,'T2M','2024-01-01',22),('coordinate',NULL,5,6,'T2M','2024-01-01',23);
            INSERT INTO TrendAnalysis VALUES ('private','a','secret analysis'),('public','public','public analysis');
            INSERT INTO Unrelated VALUES ('keep',X'00FF10');
        ''')
        refs = [{'farmId': 'a'}, {'farmId': 'public'}, {}, {'farmId': 'deleted'}, {'watchlistId': 'watch'}, {'farmId': 'a', 'watchlistId': 'other'}, {'farmId': 'public', 'watchlistId': 'watch'}, {'farmId': 4}, []]
        for i, params in enumerate(refs):
            conn.execute('INSERT INTO ProcessingJob VALUES (?,?,?)', (str(i), json.dumps(params), f'result-{i}'))
        conn.execute("INSERT INTO ProcessingJob VALUES ('bad','not json','keep malformed job')")
        conn.commit()
        return conn

    def verify(self, conn):
        self.assertEqual(conn.execute('SELECT id,ownerId,namespace,value FROM EnvironmentalObservation ORDER BY id').fetchall(), [
            ('coordinate', None, 'public', 23), ('private', 'owner-a', 'farm:a', 21), ('public', None, 'public', 22)])
        self.assertEqual(dict(conn.execute('SELECT id,ownerId FROM ProcessingJob')), {
            '0': 'owner-a', '1': None, '2': None, '3': 'unresolved:legacy', '4': 'owner-a', '5': 'unresolved:legacy', '6': 'owner-a', '7': 'unresolved:legacy', '8': 'unresolved:legacy', 'bad': 'unresolved:legacy'})
        self.assertEqual(conn.execute('SELECT id,ownerId,resultJson FROM TrendAnalysis ORDER BY id').fetchall(), [('private', 'owner-a', 'secret analysis'), ('public', None, 'public analysis')])
        self.assertEqual(conn.execute('SELECT * FROM Unrelated').fetchall(), [('keep', b'\x00\xff\x10')])
        self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM ProcessingJob').fetchone()[0], 10)

    def test_python_preserves_rows_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests', prefix='private-provider-migration-') as tmp:
            path = Path(tmp) / 'test.db'
            conn = self.fixture(path)
            conn.close()
            migration.migrate(path)
            migration.migrate(path)
            conn = sqlite3.connect(path)
            self.verify(conn)
            conn.execute("DELETE FROM Farm WHERE id='a'")
            self.assertEqual(conn.execute("SELECT ownerId FROM EnvironmentalObservation WHERE id='private'").fetchone()[0], 'owner-a')
            conn.close()

    def test_incremental_sql_has_same_backfill(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests', prefix='private-provider-migration-') as tmp:
            conn = self.fixture(Path(tmp) / 'test.db')
            sql = (ROOT / 'prisma' / 'sqlite-migrations' / '20261119140000_private_workflows' / 'migration.sql').read_text()
            conn.executescript(sql)
            self.verify(conn)
            conn.close()

    def test_foreign_key_failure_rolls_back_schema_and_data(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests', prefix='private-provider-migration-') as tmp:
            path = Path(tmp) / 'test.db'
            conn = self.fixture(path)
            conn.execute('PRAGMA foreign_keys=OFF')
            conn.execute("UPDATE EnvironmentalObservation SET farmId='missing' WHERE id='private'")
            conn.commit()
            conn.close()
            with self.assertRaisesRegex(RuntimeError, 'foreign_key_check'):
                migration.migrate(path)
            conn = sqlite3.connect(path)
            self.assertNotIn('ownerId', {r[1] for r in conn.execute('PRAGMA table_info(EnvironmentalObservation)')})
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM EnvironmentalObservation').fetchone()[0], 3)
            self.assertIn('EnvironmentalObservation_lat_lon_variable_obsDate_key', {r[1] for r in conn.execute('PRAGMA index_list(EnvironmentalObservation)')})
            conn.close()


if __name__ == '__main__':
    unittest.main()