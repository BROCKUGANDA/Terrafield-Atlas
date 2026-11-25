import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { CROP_CATALOGUE_VERSION } from '@/lib/crops/catalogue';
import { ensureSeeded } from '@/lib/seeds';

/**
 * GET /api/v1/crops
 * The versioned crop-characteristics catalogue with explicit citations.
 */
export const GET = apiHandler(async (_req, { correlationId }) => {
  await ensureSeeded();
  const rows = await db.cropCharacteristic.findMany({
    where: { catalogueVersion: CROP_CATALOGUE_VERSION, active: true },
    orderBy: { cropKey: 'asc' },
    take: 500,
  });
  return jsonResponse({
    catalogueVersion: CROP_CATALOGUE_VERSION,
    crops: rows.map((row) => ({
      cropKey: row.cropKey,
      name: row.name,
      scientificName: row.scientificName,
      family: row.family,
      familyGroup: row.familyGroup,
      growthDays: [row.growthDaysMin, row.growthDaysMax],
      waterReqMm: [row.waterReqMmMin, row.waterReqMmMax],
      waterUseClass: row.waterUseClass,
      nFixation: row.nFixation,
      nutrientDemand: row.nutrientDemand,
      soilPh: [row.soilPhMin, row.soilPhMax],
      textureSuitability: JSON.parse(row.textureSuitability),
      calorieStaple: row.calorieStaple,
      notes: row.notes,
      sources: JSON.parse(row.sources),
    })),
    catalogueNote: 'All agronomic values are published ranges with explicit citations (FAO I&D Paper 33; FAO EcoCrop; Karlen et al. 1994; FAO 2016). No LLM-invented agronomy.',
    correlationId,
  }, { correlationId });
});
