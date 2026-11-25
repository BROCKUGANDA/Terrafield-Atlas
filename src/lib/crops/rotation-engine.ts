import { CROP_CATALOGUE_VERSION, cropByKey, type CropDef } from '@/lib/crops/catalogue';
import type { RotationFactorScore, RotationScenarioResult } from '@/lib/types';

/**
 * Deterministic, explainable multi-criteria crop-rotation decision engine.
 *
 * Design contract (product mandate section 7):
 * - Pure function of (crop sequence, environmental record, soil information,
 *   farmer priorities, rule version) → identical inputs produce identical
 *   outputs; recommendations are reproducible.
 * - Missing values are NEVER treated as zero: an unmeasured input removes the
 *   affected criterion from scoring (score = null) and REDUCES CONFIDENCE.
 * - Incompatibilities are explicitly flagged, never silently buried.
 * - Every factor score ships with a plain-language explanation containing the
 *   actual numbers used.
 * - No yield or profit prediction — compatibility and evidence only.
 *
 * Rotation rules are drawn from published guidance:
 * - Family-repetition rule: consecutive plantings of the same botanical family
 *   increase soil-borne pest and disease pressure and reduce soil-health
 *   benefits of rotation [Karlen et al. 1994].
 * - Legume-N rule: legumes biologically fix nitrogen and reduce the external
 *   N requirement of a following cereal [FAO 2016, S4].
 * - Nutrient-balance rule: consecutive high-N-demand non-fixing crops
 *   accelerate soil N depletion [FAO extension guidance].
 */

export const RULE_VERSION = `rot-engine/${CROP_CATALOGUE_VERSION}`;

export interface RainfallMonthly {
  /** per calendar month: 25th/50th/75th percentile of monthly rainfall (mm) */
  p25: number[];
  p50: number[];
  p75: number[];
  years: number;
}

export interface ThermalMonthly {
  /** per calendar month: mean of monthly mean temperature (°C) */
  meanT: number[];
  years: number;
}

export interface SoilInformation {
  ph: number | null;
  texture: string | null; // texture class label
  source: 'farmer' | 'laboratory' | 'soilgrids';
  organicCarbonPct: number | null;
}

export interface Priorities {
  soilHealth: number;
  waterEfficiency: number;
  seasonalAdaptability: number;
  nutrientManagement: number;
  cropDiversity: number;
  economics: number;
  foodSecurity: number;
}

export interface EngineEnvironment {
  rainfall: RainfallMonthly | null;
  thermal: ThermalMonthly | null;
}

interface CriterionResult {
  score: number | null;
  missing?: string;
  incompatibility?: string;
  narrative: string;
}

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

function cropOrThrow(key: string): CropDef {
  const c = cropByKey(key);
  if (!c) throw new Error(`unknown crop key: ${key}`);
  return c;
}

/** Best consecutive window of `months` months by median rainfall total. */
function bestWindow(
  rainfall: RainfallMonthly,
  months: number,
): { startMonth: number; medianTotal: number; p25Total: number; p75Total: number } {
  let best = { startMonth: 1, medianTotal: -Infinity, p25Total: 0, p75Total: 0 };
  for (let start = 0; start < 12; start++) {
    let med = 0;
    let p25 = 0;
    let p75 = 0;
    for (let k = 0; k < months; k++) {
      const m = (start + k) % 12;
      med += rainfall.p50[m];
      p25 += rainfall.p25[m];
      p75 += rainfall.p75[m];
    }
    if (med > best.medianTotal) best = { startMonth: start + 1, medianTotal: med, p25Total: p25, p75Total: p75 };
  }
  return best;
}

function monthName(m: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? `M${m}`;
}

function windowLabel(startMonth: number, months: number): string {
  if (months >= 12) return 'whole-year window';
  return `${monthName(startMonth)}–${monthName(((startMonth - 1 + months - 1) % 12) + 1)} window`;
}

function durationMonths(crop: CropDef): number {
  return Math.max(1, Math.round(((crop.growthDays[0] + crop.growthDays[1]) / 2) / 30));
}

// ---------------------------------------------------------------------------
// Criterion implementations
// ---------------------------------------------------------------------------

function criterionFamilySequence(crops: CropDef[]): CriterionResult {
  let familyRepeats = 0;
  let cropRepeats = 0;
  const detail: string[] = [];
  for (let i = 1; i < crops.length; i++) {
    if (crops[i].family === crops[i - 1].family) {
      familyRepeats++;
      detail.push(`${crops[i - 1].name} → ${crops[i].name} repeats the ${crops[i].family} family`);
    }
    if (crops[i].cropKey === crops[i - 1].cropKey) {
      cropRepeats++;
      detail.push(`identical crop (${crops[i].name}) planted back-to-back`);
    }
  }
  const violations = familyRepeats;
  const score = clamp(1 - 0.3 * violations);
  return {
    score,
    narrative:
      violations === 0
        ? 'No botanical-family repetition in the sequence: each transition rotates across families, which published rotation guidance associates with lower soil-borne pest pressure and better soil-conditioning [Karlen et al., 1994].'
        : `Family-sequence rule flags ${violations} repeated-family transition(s): ${detail.join('; ')}. Repeated families concentrate related pests and reduce the soil-health benefit of rotation [Karlen et al., 1994].`,
  };
}

function criterionLegumeContribution(crops: CropDef[]): CriterionResult {
  const legumes = crops.filter((c) => c.nFixation);
  const frac = crops.length ? legumes.length / crops.length : 0;
  const score = clamp(frac / 0.5);
  return {
    score,
    narrative:
      legumes.length === 0
        ? 'No nitrogen-fixing legume in the sequence: external N inputs remain fully responsible for replacing harvested N (documented crop N demand classes from FAO extension guidance).'
        : `${legumes.length} of ${crops.length} positions are N-fixing legumes (${legumes.map((l) => l.name).join(', ')}). Biological N fixation reduces the external N requirement of a following cereal, though the actual credit depends on inoculation, biomass and residue management [FAO 2016].`,
  };
}

function criterionWater(crops: CropDef[], env: EngineEnvironment): CriterionResult {
  if (!env.rainfall) {
    return {
      score: null,
      missing: 'No NASA POWER rainfall record has been ingested for this location — water-demand compatibility not assessed (missing input, not a zero score).',
      narrative:
        'Water-demand compatibility was NOT assessed: the seasonal rainfall climatology required to compare documented crop water requirements is unavailable for this farm. Ingest the POWER record first.',
    };
  }
  const parts: string[] = [];
  let total = 0;
  let worstRatio = Infinity;
  let irrigationFlagged = false;
  for (const crop of crops) {
    const months = durationMonths(crop);
    const w = bestWindow(env.rainfall, months);
    const reqMid = (crop.waterReqMm[0] + crop.waterReqMm[1]) / 2;
    const ratio = w.medianTotal / Math.max(reqMid, 1);
    worstRatio = Math.min(worstRatio, ratio);
    const s = clamp(0.5 + (ratio - 1) / 0.7);
    total += s;
    parts.push(
      `${crop.name} needs ${crop.waterReqMm[0]}–${crop.waterReqMm[1]} mm per season [FAO I&D Paper 33]; its best ${windowLabel(w.startMonth, months)} median rainfall in the ${env.rainfall.years}-year POWER record is ${Math.round(w.medianTotal)} mm (interquartile ${Math.round(w.p25Total)}–${Math.round(w.p75Total)} mm)`,
    );
    if (w.p75Total < crop.waterReqMm[0]) irrigationFlagged = true;
  }
  const score = clamp(total / crops.length);
  const incompatibility =
    worstRatio < 0.55 && !irrigationFlagged
      ? undefined
      : irrigationFlagged
        ? 'One or more crops have documented water requirements above the 75th-percentile rainfall of their best window — rainfed cultivation is likely infeasible without irrigation (flagged, not scored silently).'
        : undefined;
  return {
    score,
    incompatibility,
    narrative: `${parts.join('. ')}. Overall water-compatibility score ${Math.round(score * 100)}/100${irrigationFlagged ? '; irrigation would be required for the flagged crop(s)' : ''}.`,
  };
}

function criterionSeasonal(crops: CropDef[], env: EngineEnvironment): CriterionResult {
  if (!env.thermal) {
    return {
      score: null,
      missing: 'No NASA POWER temperature record — seasonal (thermal) feasibility not assessed.',
      narrative:
        'Seasonal feasibility was NOT assessed: the temperature climatology needed to compute the warm-season length is unavailable for this farm.',
    };
  }
  const t = env.thermal.meanT;
  const longestWarmRun = (() => {
    let best = 0;
    let run = 0;
    for (let i = 0; i < 24; i++) {
      const m = i % 12;
      if (t[m] >= 12) run++;
      else run = 0;
      best = Math.max(best, run);
    }
    return best;
  })();
  const longestCoolRun = (() => {
    let best = 0;
    let run = 0;
    for (let i = 0; i < 24; i++) {
      const m = i % 12;
      if (t[m] >= 5) run++;
      else run = 0;
      best = Math.max(best, run);
    }
    return best;
  })();
  const parts: string[] = [];
  let sum = 0;
  let infeasible = false;
  for (const crop of crops) {
    const need = durationMonths(crop);
    const run = crop.thermalClass === 'temperate' ? longestCoolRun : longestWarmRun;
    const fit = run >= need;
    const near = run >= need - 1;
    if (!fit && !near) infeasible = true;
    const s = fit ? 1 : near ? 0.6 : 0.25;
    sum += s;
    parts.push(
      `${crop.name} (${crop.thermalClass} adaptation class) needs ~${need} growing month(s); the ${crop.thermalClass === 'temperate' ? '≥5 °C' : '≥12 °C mean'} season spans ~${run} consecutive month(s)`,
    );
  }
  return {
    score: clamp(sum / crops.length),
    incompatibility: infeasible
      ? 'At least one crop cannot reliably complete its documented growth cycle inside the available thermal season — flagged as infeasible for this site without irrigation/protected cultivation.'
      : undefined,
    narrative: `${parts.join('; ')}, from the ${env.thermal.years}-year POWER temperature climatology.`,
  };
}

function criterionNutrientBalance(crops: CropDef[], soil: SoilInformation | null): CriterionResult {
  let violations = 0;
  let benefits = 0;
  const notes: string[] = [];
  for (let i = 1; i < crops.length; i++) {
    const prev = crops[i - 1];
    const cur = crops[i];
    if (prev.nutrientDemand === 'high' && cur.nutrientDemand === 'high' && !cur.nFixation) {
      violations++;
      notes.push(`${prev.name} → ${cur.name}: consecutive high-N-demand non-fixing crops accelerate N depletion [FAO extension guidance]`);
    }
    if (prev.nFixation && cur.nutrientDemand === 'high') {
      benefits++;
      notes.push(`${prev.name} → ${cur.name}: legume precedes a high-N-demand crop (documented N-credit pattern [FAO 2016])`);
    }
  }
  const score = clamp(1 - 0.2 * violations + 0.15 * benefits);
  const soilNote = soil
    ? soil.source === 'soilgrids'
      ? ' Soil N status itself is unmeasured (the SoilGrids profile supplies pH/texture only, as modeled estimates).'
      : ' Measured soil N was not supplied in the soil test, so the initial soil-N status is still unknown.'
    : ' No soil test exists yet, so the baseline nutrient status is unknown — the balance rule is applied to crop classes only.';
  return {
    score,
    narrative:
      (notes.length ? notes.join('; ') : 'No documented nutrient-demand conflicts or legume-N credit patterns in this sequence.') +
      soilNote,
  };
}

function criterionDiversity(crops: CropDef[]): CriterionResult {
  const families = new Set(crops.map((c) => c.family));
  const score = crops.length <= 1 ? 0 : clamp((families.size - 1) / (crops.length - 1));
  return {
    score,
    narrative:
      crops.length <= 1
        ? 'A single-crop sequence provides no rotational diversity (score 0 by definition, not by missing data).'
        : `${families.size} distinct botanical families across ${crops.length} positions (${[...families].join(', ')}). Diverse rotations are documented to reduce pest risk and stabilise soil function [Karlen et al., 1994].`,
  };
}

function criterionSoil(crops: CropDef[], soil: SoilInformation | null): CriterionResult {
  if (!soil) {
    return {
      score: null,
      missing: 'No soil information (no farmer/lab test, no SoilGrids profile) — soil-suitability not assessed.',
      narrative:
        'Soil suitability was NOT assessed: neither a soil test nor a SoilGrids profile is available for this farm. Enter a soil test (or fetch the supplementary SoilGrids profile) to enable this criterion.',
    };
  }
  const phScores: number[] = [];
  const phNotes: string[] = [];
  let phIncompatible: string | undefined;
  for (const crop of crops) {
    const [lo, hi] = crop.soilPh;
    if (soil.ph === null || !Number.isFinite(soil.ph)) {
      return {
        score: null,
        missing: 'Soil profile exists but pH is missing — soil-suitability not assessed.',
        narrative: 'The available soil profile lacks a pH value, so pH compatibility cannot be evaluated.',
      };
    }
    const inside = soil.ph >= lo && soil.ph <= hi;
    const near = soil.ph >= lo - 0.5 && soil.ph <= hi + 0.5;
    const s = inside ? 1 : near ? 0.5 : 0;
    if (!near) {
      phIncompatible = `Measured pH ${soil.ph.toFixed(1)} lies outside the documented ${crop.name} range (${lo}–${hi}) by more than the 0.5 tolerance — this crop is flagged as incompatible with the measured soil reaction [FAO EcoCrop ranges].`;
    }
    phScores.push(s);
    phNotes.push(`${crop.name} (pH ${lo}–${hi}): ${inside ? 'compatible' : near ? 'marginal (±0.5 tolerance)' : 'incompatible'}`);
  }
  const textureScores: number[] = [];
  const textureNotes: string[] = [];
  if (soil.texture) {
    for (const crop of crops) {
      const best = crop.textureBest.includes(soil.texture);
      const ok = crop.textureAcceptable.includes(soil.texture);
      textureScores.push(best ? 1 : ok ? 0.75 : 0.4);
      textureNotes.push(
        `${crop.name}: ${best ? 'best-texture match' : ok ? 'acceptable texture' : 'texture outside documented best/acceptable list'}`,
      );
    }
  }
  const phScore = phScores.reduce((a, b) => a + b, 0) / phScores.length;
  const texScore = textureScores.length ? textureScores.reduce((a, b) => a + b, 0) / textureScores.length : null;
  const score = texScore === null ? phScore : clamp(0.6 * phScore + 0.4 * texScore);
  const sourceNote =
    soil.source === 'soilgrids'
      ? ' Soil values are SoilGrids MODEL estimates (250 m grid), not in-field measurements — a laboratory test is recommended before final decisions.'
      : soil.source === 'laboratory'
        ? ' pH measured by laboratory test.'
        : ' pH farmer-measured.';
  return {
    score: clamp(score),
    incompatibility: phIncompatible,
    narrative: `pH: ${phNotes.join('; ')}.${textureNotes.length ? ` Texture: ${textureNotes.join('; ')}.` : ''}${sourceNote}`,
  };
}

function criterionFoodSecurity(crops: CropDef[]): CriterionResult {
  const staples = crops.filter((c) => c.calorieStaple);
  return {
    score: staples.length ? 1 : 0,
    narrative: staples.length
      ? `The sequence includes documented calorie-staple crop(s) (${staples.map((s) => s.name).join(', ')}), relevant to household food security.`
      : 'No documented calorie-staple crop (maize, wheat, sorghum, millet, potato, cassava, sweet potato) in the sequence — if household food self-sufficiency matters, this is a deliberate trade-off.',
  };
}

function criterionEconomics(): CriterionResult {
  return {
    score: null,
    missing:
      'No market-price or input-cost data source is configured — economic comparison not assessed (never estimated from invented prices).',
    narrative:
      'Economic assessment is NOT available: the deployment has no configured market-price or input-cost source, and TerraField Atlas refuses to invent prices. Compare options on the assessed criteria and consult local market data for economics.',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function evaluateRotation(
  cropKeys: string[],
  name: string,
  env: EngineEnvironment,
  soil: SoilInformation | null,
  priorities: Priorities,
): RotationScenarioResult {
  if (cropKeys.length < 1) throw new Error('crop sequence is empty');
  if (cropKeys.length > 8) throw new Error('crop sequence too long (max 8 positions for the demo)');
  const crops = cropKeys.map(cropOrThrow);

  const criteria: { key: keyof Priorities; factor: RotationFactorScore }[] = [];

  const push = (key: keyof Priorities, criterion: string, r: CriterionResult) => {
    criteria.push({
      key,
      factor: {
        criterion,
        weight: 0, // filled after normalization
        score: r.score,
        missingDataReason: r.missing,
        explanation: r.narrative + (r.incompatibility ? ` INCOMPATIBILITY: ${r.incompatibility}` : ''),
      },
    });
  };

  push('soilHealth', 'Family-sequence compatibility (soil health)', criterionFamilySequence(crops));
  push('nutrientManagement', 'Legume nitrogen contribution', criterionLegumeContribution(crops));
  push('waterEfficiency', 'Water-demand compatibility (FAO ranges vs POWER rainfall)', criterionWater(crops, env));
  push('seasonalAdaptability', 'Seasonal (thermal) feasibility', criterionSeasonal(crops, env));
  push('nutrientManagement', 'Nutrient-balance sequence rule', criterionNutrientBalance(crops, soil));
  push('cropDiversity', 'Crop diversity (families per position)', criterionDiversity(crops));
  push('soilHealth', 'Soil pH & texture suitability', criterionSoil(crops, soil));
  push('foodSecurity', 'Staple-calorie presence', criterionFoodSecurity(crops));
  push('economics', 'Economic viability', criterionEconomics());

  // Normalize farmer priorities to sum 1
  const raw = [
    priorities.soilHealth,
    priorities.waterEfficiency,
    priorities.seasonalAdaptability,
    priorities.nutrientManagement,
    priorities.cropDiversity,
    priorities.economics,
    priorities.foodSecurity,
  ];
  const sumRaw = raw.reduce((a, b) => a + b, 0);
  const norm = raw.map((v) => (sumRaw > 0 ? v / sumRaw : 0));
  const priorityWeight: Record<string, number> = {
    soilHealth: norm[0],
    waterEfficiency: norm[1],
    seasonalAdaptability: norm[2],
    nutrientManagement: norm[3],
    cropDiversity: norm[4],
    economics: norm[5],
    foodSecurity: norm[6],
  };

  // distribute each priority's normalized weight across its criteria
  const perKeyCounts: Record<string, number> = {};
  for (const c of criteria) perKeyCounts[c.key] = (perKeyCounts[c.key] ?? 0) + 1;
  const factors: RotationFactorScore[] = criteria.map((c) => ({
    criterion: c.factor.criterion,
    weight: Number(((priorityWeight[c.key as string] ?? 0) / (perKeyCounts[c.key as string] ?? 1)).toFixed(6)),
    score: c.factor.score,
    missingDataReason: c.factor.missingDataReason,
    explanation: c.factor.explanation,
  }));

  // weighted mean over ASSESSED criteria only; missing ones reduce confidence
  const assessed = factors.filter((f) => f.score !== null && f.weight > 0);
  const weightSum = factors.reduce((a, f) => a + f.weight, 0);
  const assessedWeight = assessed.reduce((a, f) => a + f.weight, 0);
  const overallScore =
    assessedWeight > 0
      ? Number((assessed.reduce((a, f) => a + f.weight * (f.score as number), 0) / assessedWeight).toFixed(2))
      : 0;

  // coverage-based confidence, multiplied by data-quality factors
  let quality = 1;
  if (soil?.source === 'soilgrids') quality *= 0.85;
  if (env.rainfall && env.rainfall.years < 10) quality *= 0.9;
  const confidence = Number((clamp(assessedWeight / Math.max(weightSum, 1e-9)) * quality).toFixed(2));

  const incompatible = factors
    .map((f) => (f.explanation.includes('INCOMPATIBILITY:') ? { rule: f.criterion, detail: f.explanation.split('INCOMPATIBILITY:')[1].trim() } : null))
    .filter(Boolean) as { rule: string; detail: string }[];

  const missingInformation = factors
    .filter((f) => f.score === null)
    .map((f) => f.missingDataReason ?? `${f.criterion} not assessed`);

  const narrative: string[] = [];
  const best = [...assessed].sort((a, b) => (b.score as number) - (a.score as number))[0];
  const worst = [...assessed].sort((a, b) => (a.score as number) - (b.score as number))[0];
  if (best) narrative.push(`Strongest assessed dimension: ${best.criterion} (${Math.round((best.score as number) * 100)}/100 under the farmer's priorities).`);
  if (worst && worst !== best) narrative.push(`Weakest assessed dimension: ${worst.criterion} (${Math.round((worst.score as number) * 100)}/100).`);
  if (incompatible.length) narrative.push(`Incompatibility flag(s): ${incompatible.map((i) => i.detail).join(' | ')}`);
  if (missingInformation.length) narrative.push(`Assessment coverage is incomplete: ${missingInformation.length} criterion/criteria could not be scored${confidence < 1 ? ` and reduce confidence instead of silently counting as zero (${Math.round(confidence * 100)}% confidence)` : ' (the unassessed criterion carries zero weight under the current priorities, so confidence is unaffected)'}.`);
  narrative.push('Scores express evidence-based compatibility only; they do NOT predict yield or profit.');

  return {
    scenarioName: name,
    cropKeys,
    cropNames: crops.map((c) => c.name),
    factors,
    overallScore,
    confidence,
    incompatible,
    missingInformation,
    narrative,
    ruleVersion: RULE_VERSION,
    weightsUsed: priorityWeight,
  };
}
