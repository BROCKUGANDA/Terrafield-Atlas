require('@next/env').loadEnvConfig(process.cwd());
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  try {
    const jobs = await db.processingJob.findMany({ take: 100, orderBy: { startedAt: 'desc' } });
    let tested = false;
    for (const job of jobs) {
      let params;
      try { params = JSON.parse(job.params); } catch { continue; }
      if (params.watchlistId) continue;
      if (params.farmId) {
        const farm = await db.farm.findUnique({ where: { id: params.farmId }, select: { ownerId: true } });
        if (!farm || farm.ownerId) continue;
      }
      const response = await fetch(`https://terrafieldatlas.us/api/v1/analysis/jobs/${encodeURIComponent(job.id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).job.id, job.id);
      tested = true;
      break;
    }
    assert.equal(tested, true, 'No public job fixture available');
    assert.equal((await fetch('https://terrafieldatlas.us/api/v1/analysis/jobs/nonexistent-validation-fixture')).status, 404);
    console.log('PASS public job status preserved; nonexistent identifiers denied');
  } finally { await db.$disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });