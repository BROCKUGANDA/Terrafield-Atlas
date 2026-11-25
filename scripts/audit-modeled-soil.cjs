const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  try {
    const records = await db.soilTest.findMany({ where: { source: 'soilgrids' }, select: { id: true, createdAt: true, ph: true, nitrogenMgKg: true, organicCarbonPct: true, sandPct: true, clayPct: true } });
    const older = records.filter(r => r.createdAt < new Date('2026-11-19T09:00:00Z'));
    const populated = r => ['ph', 'nitrogenMgKg', 'organicCarbonPct', 'sandPct', 'clayPct'].some(key => r[key] !== null);
    console.log(JSON.stringify({ modeledProfiles: records.length, oldEmptyProfiles: older.filter(r => !populated(r)).map(r => r.id), reviewRequired: older.filter(populated).map(r => r.id), note: 'Read-only audit. Empty historical modeled records contain no numeric units to rewrite. Populated older profiles need provenance review/re-ingestion; laboratory measurements are untouched.' }));
  } finally { await db.$disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });