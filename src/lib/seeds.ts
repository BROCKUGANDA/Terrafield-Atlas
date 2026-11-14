import { db } from '@/lib/db';
import { CROP_CATALOGUE, CROP_CATALOGUE_VERSION } from '@/lib/crops/catalogue';
import { GIBS_LAYERS } from '@/lib/adapters/gibsLayers';

/**
 * Database seeding: the DataSource register and the versioned crop catalogue.
 * Idempotent — safe to call on every boot.
 */

const DATA_SOURCES = [
  {
    provider: 'NASA Langley Research Center (LaRC) — POWER Project',
    datasetName: 'POWER Daily API v2 (point requests)',
    productId: 'MERRA-2 assimilated daily meteorology',
    endpointTemplate: 'https://power.larc.nasa.gov/api/temporal/daily/point?parameters={vars}&community=AG&longitude={lon}&latitude={lat}&start={YYYYMMDD}&end={YYYYMMDD}&format=JSON',
    dataFormat: 'JSON',
    temporalCoverage: '1981-01-02 → present minus ~3 days',
    spatialResolution: '0.5° × 0.625° (≈ 55 km × 62 km at the equator) grid cell',
    units: 'mm/day (precipitation), °C (temperature), kWh/m²/day (radiation), % (humidity), fraction 0–1 (soil wetness)',
    authRequired: false,
    rateLimit: 'Public API; sustained ~1 request/sec recommended',
    license: 'NASA open data (no restrictions on use), attribution requested',
    attribution: 'NASA POWER, NASA Langley Research Center (LaRC)',
    limitations:
      'Reanalysis grid-cell values, not station observations: they approximate the regional climate, never the exact microclimate of a farm. LST (local solar time) day boundaries, not UTC. Heavy convective precipitation can be underestimated.',
    status: 'operational',
  },
  {
    provider: 'NASA EOSDIS — Global Imagery Browse Services (GIBS)',
    datasetName: 'MODIS Terra Corrected Reflectance True Color (daily, 250 m)',
    productId: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    endpointTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
    dataFormat: 'WMTS raster tiles (JPEG)',
    temporalCoverage: '2000-02-24 → present',
    spatialResolution: '250 m per pixel',
    units: 'visual imagery (no units)',
    authRequired: false,
    rateLimit: 'public CDN, no key',
    license: 'NASA open data',
    attribution: 'Imagery courtesy of NASA EOSDIS GIBS',
    limitations: 'Cloud cover obscures the surface on any given day. Visualization only — not a quantitative measurement.',
    status: 'operational',
  },
  {
    provider: 'NASA EOSDIS — GIBS',
    datasetName: 'MODIS Terra NDVI 16-Day composite (MOD13Q1 rendering)',
    productId: 'MOD13Q1 v6.1 (rendered via MODIS_Terra_L3_NDVI_16Day)',
    endpointTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_16Day/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
    dataFormat: 'WMTS raster tiles (PNG, colormap-rendered)',
    temporalCoverage: '2000-02 → present (16-day composites starting Jan 1 + 16k)',
    spatialResolution: '250 m per pixel',
    units: 'NDVI colormap (−0.2 … 1.0 rendered scale)',
    authRequired: false,
    rateLimit: 'public CDN, no key',
    license: 'NASA open data',
    attribution: 'MOD13Q1 via NASA EOSDIS GIBS / Land Processes DAAC',
    limitations:
      'Colormap rendering for visualization. Quantitative per-pixel NDVI with QA flags requires MOD13Q1 science files via Earthdata/AppEEARS (credentials not configured in this deployment). Individual vegetation indices are NOT direct yield measurements.',
    status: 'operational',
  },
  {
    provider: 'NASA EOSDIS — GIBS',
    datasetName: 'SMAP L4 Analyzed Root-Zone Soil Moisture (rendered)',
    productId: 'SPL4SMGP.007 (SMAP L4 Surface/Root-Zone Analysis)',
    endpointTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SMAP_L4_Analyzed_Root_Zone_Soil_Moisture/default/{date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
    dataFormat: 'WMTS raster tiles (PNG, colormap-rendered)',
    temporalCoverage: '2015-03-31 → present (≈3-day lag)',
    spatialResolution: '≈ 9 km native SMAP L4 grid',
    units: 'm³/m³ soil moisture (colormap-rendered)',
    authRequired: false,
    rateLimit: 'public CDN, no key',
    license: 'NASA open data',
    attribution: 'NASA SMAP mission via EOSDIS GIBS',
    limitations:
      '9 km grid: regional estimates, NEVER field-level precision. Land-model assimilation output, not a direct measurement. Used here as a map layer only; never substitutes for measured soil properties.',
    status: 'operational',
  },
  {
    provider: 'NASA EOSDIS — GIBS',
    datasetName: 'VIIRS Suomi-NPP 375 m thermal anomalies (active fires, vector tiles)',
    productId: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',
    endpointTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_Thermal_Anomalies_375m_All/default/{date}/500m/7/{row}/{col}.mvt',
    dataFormat: 'Mapbox Vector Tiles (decoded server-side)',
    temporalCoverage: '2015-01-01 → present (isolated gap days; verified via GIBS Domains service)',
    spatialResolution: '375 m VIIRS detections within 2.25° × 2.25° tiles',
    units: 'detection points with confidence (l/n/h), FRP (MW), brightness temperatures (K)',
    authRequired: false,
    rateLimit: 'public CDN, no key',
    license: 'NASA open data',
    attribution: 'VIIRS active-fire detections via NASA EOSDIS GIBS (same detection stream distributed by NASA FIRMS)',
    limitations:
      'Detections are instantaneous overpass observations (twice daily, day/night): fires that start and end between overpasses are invisible. 375 m resolution means small or smoldering fires can be missed. Clouds block detection. Archived gap days exist.',
    status: 'operational',
  },
  {
    provider: 'NASA FIRMS (Fire Information for Resource Management System)',
    datasetName: 'FIRMS area CSV API (MODIS/VIIRS)',
    productId: 'VIIRS_SNPP_NRT / MODIS_NRT',
    endpointTemplate: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{bbox}/{dayRange}',
    dataFormat: 'CSV',
    temporalCoverage: 'rolling near-real-time + archive (with MAP_KEY)',
    spatialResolution: '375 m (VIIRS) / 1 km (MODIS)',
    units: 'detection rows with confidence, FRP',
    authRequired: true,
    rateLimit: 'requires free MAP_KEY registration',
    license: 'NASA open data',
    attribution: 'NASA FIRMS / LANCE',
    limitations:
      'NOT REACHABLE from this deployment sandbox (connection timeouts verified) and MAP_KEY not configured. The adapter is implemented and health-flagged; fire features are served from the GIBS VIIRS thermal-anomaly stream instead. No data is ever fabricated for this source.',
    status: 'unreachable',
  },
  {
    provider: 'ISRIC — World Soil Information',
    datasetName: 'SoilGrids v2.0 point REST',
    productId: 'SoilGrids 2.0 (2020 release)',
    endpointTemplate: 'https://rest.isric.org/soilgrids/v2.0/properties/query?lon={lon}&lat={lat}&property={prop}&value=mean&depth=0-5cm',
    dataFormat: 'JSON',
    temporalCoverage: 'static modeled layers (2020/2023 releases)',
    spatialResolution: '250 m modeled grid',
    units: 'pH, g/kg C, % sand, % clay, g/kg N (d_factor converted)',
    authRequired: false,
    rateLimit: 'public service, intermittent slowness observed',
    license: 'CC BY 4.0',
    attribution: 'SoilGrids 2.0, ISRIC — World Soil Information',
    limitations:
      'Modeled predictions (regression-kriging), NOT in-field measurements. SUPPLEMENTARY only: always labeled, always lower confidence, never silently substituted for a farmer/lab soil test.',
    status: 'operational',
  },
];

export async function ensureSeeded(): Promise<void> {
  // Data sources
  const existing = await db.dataSource.count();
  if (existing === 0) {
    await db.dataSource.createMany({ data: DATA_SOURCES.map((s) => ({ ...s, lastCheckedAt: new Date() })) });
  }
  // Crop catalogue (versioned)
  const cropCount = await db.cropCharacteristic.count({
    where: { catalogueVersion: CROP_CATALOGUE_VERSION },
  });
  if (cropCount === 0) {
    await db.cropCharacteristic.createMany({
      data: CROP_CATALOGUE.map((c) => ({
        catalogueVersion: CROP_CATALOGUE_VERSION,
        cropKey: c.cropKey,
        name: c.name,
        scientificName: c.scientificName,
        family: c.family,
        familyGroup: c.familyGroup,
        growthDaysMin: c.growthDays[0],
        growthDaysMax: c.growthDays[1],
        waterReqMmMin: c.waterReqMm[0],
        waterReqMmMax: c.waterReqMm[1],
        waterUseClass: c.waterUseClass,
        nFixation: c.nFixation,
        nutrientDemand: c.nutrientDemand,
        thermalClass: c.thermalClass,
        calorieStaple: c.calorieStaple,
        soilPhMin: c.soilPh[0],
        soilPhMax: c.soilPh[1],
        textureSuitability: JSON.stringify({ best: c.textureBest, acceptable: c.textureAcceptable }),
        notes: c.notes,
        sources: JSON.stringify(c.sources),
        active: true,
      })),
    });
  }
}

export const GIBS_LAYER_COUNT = GIBS_LAYERS.length;
