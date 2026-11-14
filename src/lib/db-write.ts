import { Prisma } from '@prisma/client';

/**
 * Race-safe bulk idempotent writes on SQLite.
 *
 * WHY: SQLite + Prisma supports no `skipDuplicates` on createMany, so the
 * code pre-reads existing natural keys and inserts only fresh rows. That is
 * correct for a single writer but RACES under concurrent requests: between
 * the dedupe read and the createMany, another request can insert the same
 * natural key → Prisma P2002 → the whole chunk (and its job) fails. This is
 * exactly what happened to the recorded 'power-ingest' failed job.
 *
 * CONTRACT: try the fast bulk insert; on a unique violation fall back to
 * row-by-row inserts where an already-existing row is treated as SUCCESS
 * (the concurrent winner wrote the identical real observation — the data
 * is present, which is the goal). Genuine non-duplicate errors still throw.
 */

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface CreateManyDelegate<T> {
  createMany(args: { data: T[] }): Promise<{ count: number }>;
}

export async function createManyIdempotent<T>(
  delegate: CreateManyDelegate<T>,
  data: T[],
  opts: { chunkSize?: number; onDuplicate?: 'skip' } = {},
): Promise<number> {
  const chunkSize = opts.chunkSize ?? 500;
  let written = 0;
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.slice(i, i + chunkSize);
    try {
      const res = await delegate.createMany({ data: slice });
      written += res.count;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Race lost on at least one row of this chunk — resolve row-by-row.
      for (const row of slice) {
        try {
          const single = await delegate.createMany({ data: [row] });
          written += single.count;
        } catch (rowErr) {
          if (isUniqueViolation(rowErr)) continue; // concurrent winner has the identical real row
          throw rowErr;
        }
      }
    }
  }
  return written;
}
