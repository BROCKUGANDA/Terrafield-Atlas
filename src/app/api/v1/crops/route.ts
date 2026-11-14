import { db } from '@/lib/db';
import { jsonResponse } from '@/lib/api/helpers';
import { CROP_CATALOGUE, CROP_CATALOGUE_VERSION } from '@/lib/crops/catalogue';
import { ensureSeeded } from '@/lib/seeds';

/**
 * GET /api/v1/crops
 * The versioned crop-characteristics catalogue with explicit citations.
 */
export async function GET() {
  await ensureSeeded();
  const rows = await db.cropCharacteristic.findMany({
    where: { catalogueVersion: CROP_CATALOGUE_VERSION, active: true },
  });
  return jsonResponse({
    catalogueVersion: CROP_CATALOGUE_VERSION,
    crops: rows.map((r) => ({
      cropKey: r.cropKey,
      name: r.name,
      scientificName: r.scientificName,
      family: r.family,
      familyGroup: r.familyGroup,
      growthDays: [r.growthDaysMin, r.growthDaysMax],
      waterReqMm: [r.waterReqMmMin, r.waterReqMmMax],
      waterUseClass: r.waterUseClass,
      nFixation: r.nFixation,
      nutrientDemand: r.nutrientDemand,
      soilPh: [r.soilPhMin, r.soilPhMax],
      textureSuitability: JSON.parse(r.textureSuitability),
      calorieStaple: r.calorieStaple,
      notes: r.notes,
      sources: JSON.parse(r.sources),
    })),
    catalogueNote:
      'All agronomic values are published ranges with explicit citations (FAO I&D Paper 33 for water requirements; FAO EcoCrop/extension guidance for pH and adaptation classes; Karlen et al. 1994 and FAO 2016 for rotation rules). No LLM-invented agronomy.',
  });
}
