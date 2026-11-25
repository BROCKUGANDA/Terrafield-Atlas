import { Prisma } from '@prisma/client';

/**
 * Race-safe bulk idempotent writes.
 *
 * WHY: the natural key of every observation/detection row is enforced by a
 * PostgreSQL unique index. A pre-read followed by a bulk insert is correct for
 * a single writer but RACES under concurrent jobs: between the dedupe read and
 * the insert, another writer can insert the same natural key.
 *
 * CONTRACT: PostgreSQL's `skipDuplicates` turns the bulk insert into a true
 * natural-key UPSERT — the database arbitrates, so a concurrent writer can
 * never fail the chunk and the reported count is exactly the number of newly
 * stored rows. When the dialect rejects `skipDuplicates`, the helper falls
 * back to row-by-row inserts where an already-existing row counts as success
 * (the concurrent winner wrote the identical real observation).
 */

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface CreateManyDelegate<T> {
  createMany(args: { data: T[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
}

export async function createManyIdempotent<T>(
  delegate: CreateManyDelegate<T>,
  data: T[],
  opts: { chunkSize?: number } = {},
): Promise<number> {
  const chunkSize = opts.chunkSize ?? 500;
  let written = 0;
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.slice(i, i + chunkSize);
    try {
      const res = await delegate.createMany({ data: slice, skipDuplicates: true });
      written += res.count;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // The dialect refused skipDuplicates: fall back to row-by-row inserts.
        if (!(err instanceof Error) || !/skipDuplicates|unknown argument/i.test(err.message)) throw err;
        for (const row of slice) {
          try {
            const single = await delegate.createMany({ data: [row] });
            written += single.count;
          } catch (rowErr) {
            if (isUniqueViolation(rowErr)) continue; // concurrent winner has the identical real row
            throw rowErr;
          }
        }
        continue;
      }
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
