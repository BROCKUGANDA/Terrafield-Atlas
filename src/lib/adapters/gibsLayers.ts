/**
 * NASA GIBS layer registry.
 *
 * Provider: NASA EOSDIS Global Imagery Browse Services (GIBS)
 * Endpoint:  https://gibs.earthdata.nasa.gov/wmts/{epsg}/best/{Layer}/default/{Time}/{TMS}/{z}/{y}/{x}.{ext}
 * Auth:      none (public), no credentials ever required
 * Attribution: "Imagery courtesy of NASA EOSDIS GIBS"
 *
 * All layer identifiers, tile matrix sets and formats below were extracted from
 * the live WMTS GetCapabilities documents (retrieved this session):
 *  - epsg3857/best/1.0.0/WMTSCapabilities.xml (for MapLibre raster layers)
 *  - epsg4326/best/1.0.0/WMTSCapabilities.xml (for MVT vector layers)
 */

export interface GibsLayerDef {
  id: string; // GIBS layer identifier
  name: string;
  group: 'satellite-imagery' | 'vegetation' | 'soil-moisture';
  format: 'image/jpeg' | 'image/png';
  tileMatrixSet: string; // GoogleMapsCompatible_LevelN (EPSG:3857)
  maxzoom: number; // MapLibre maxzoom hint (zoom at which native resolution is reached)
  resolution: string; // native/derived spatial resolution, shown in UI
  temporalCoverage: string;
  cadence: string;
  dateValidator: (date: string) => string | null; // snaps requested date to a valid one, or null if invalid
  description: string;
  productSource: string; // underlying NASA science product
  limitations: string;
}

/** Snap a date to the most recent valid MOD13Q1 16-day composite start (Jan 1 + 16k). */
export function snapTo16Day(date: string): string | null {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear()) return null;
  const jan1 = Date.UTC(year, 0, 1);
  const days = Math.floor((d.getTime() - jan1) / 86_400_000);
  const snapped = jan1 + Math.floor(days / 16) * 16 * 86_400_000;
  const iso = new Date(snapped).toISOString().slice(0, 10);
  return iso > date ? new Date(snapped - 16 * 86_400_000).toISOString().slice(0, 10) : iso;
}

function dailyValid(date: string, fromYear: number): string | null {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const min = new Date(Date.UTC(fromYear, 0, 1));
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  if (d < min || d > now) return null;
  return date;
}

export const GIBS_LAYERS: GibsLayerDef[] = [
  {
    id: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    name: 'MODIS Terra — True Color (daily, 250 m)',
    group: 'satellite-imagery',
    format: 'image/jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxzoom: 9,
    resolution: '250 m per pixel',
    temporalCoverage: '2000-02-24 → present',
    cadence: 'daily',
    dateValidator: (d) => dailyValid(d, 2000),
    description: 'Corrected reflectance true-color imagery from the MODIS instrument aboard Terra.',
    productSource: 'MODIS/Terra V NP.006 (near real-time corrected reflectance via GIBS)',
    limitations: 'Cloud cover obscures the surface on any given day; imagery is visual, not a quantitative measurement.',
  },
  {
    id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    name: 'VIIRS Suomi-NPP — True Color (daily, 250 m)',
    group: 'satellite-imagery',
    format: 'image/jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxzoom: 9,
    resolution: '250 m per pixel',
    temporalCoverage: '2015-11-24 → present',
    cadence: 'daily',
    dateValidator: (d) => dailyValid(d, 2015),
    description: 'Corrected reflectance true-color imagery from VIIRS aboard Suomi NPP.',
    productSource: 'VIIRS/SNPP (via GIBS)',
    limitations: 'Cloud cover obscures the surface on any given day.',
  },
  {
    id: 'MODIS_Terra_L3_NDVI_16Day',
    name: 'MODIS Terra NDVI — 16-Day composite (250 m)',
    group: 'vegetation',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxzoom: 9,
    resolution: '250 m per pixel (MOD13Q1 native)',
    temporalCoverage: '2000-02 → present',
    cadence: '16-day composite',
    dateValidator: snapTo16Day,
    description: 'Normalized Difference Vegetation Index, 16-day composite — rendering of the MOD13Q1 vegetation-index product.',
    productSource: 'MODIS/Terra MOD13Q1 v6.1 vegetation indices (rendered by GIBS)',
    limitations:
      'Colormap rendering for visualization; quantitative per-pixel NDVI with QA flags requires the MOD13Q1 science files via Earthdata (credentials not configured in this deployment). Dates snap to composite start dates (Jan 1 + 16-day steps). Cloud/aerosol QA filtering is applied upstream in the composite, but residual contamination is possible.',
  },
  {
    id: 'SMAP_L4_Analyzed_Root_Zone_Soil_Moisture',
    name: 'SMAP L4 — Root-zone soil moisture (9 km)',
    group: 'soil-moisture',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    maxzoom: 6,
    resolution: '≈ 9 km native grid (SMAP L4 v5), rendered tiles are 2 km class',
    temporalCoverage: '2015-03-31 → present (3-day lag)',
    cadence: 'daily',
    dateValidator: (d) => dailyValid(d, 2015),
    description: 'SMAP Level-4 analyzed root-zone soil moisture (0–100 cm), land-surface model assimilation of SMAP observations.',
    productSource: 'SMAP L4_Soil Moisture Analysis (SPL4SMGP.007) — NASA SMAP mission',
    limitations:
      '9 km grid cell values are regional estimates and DO NOT represent field-scale soil moisture; never used as a substitute for measured soil properties. Values are colormap-rendered for visualization.',
  },
];

export function gibsRasterTileUrl(layerId: string, date: string, z: number, x: number, y: number, fmt: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layerId}/default/${date}/GoogleMapsCompatible_Level${maxzoomFor(layerId)}/${z}/${y}/${x}.${fmt === 'image/jpeg' ? 'jpg' : 'png'}`;
}

function maxzoomFor(layerId: string): number {
  const def = GIBS_LAYERS.find((l) => l.id === layerId);
  if (!def) throw new Error(`unknown GIBS layer ${layerId}`);
  return def.maxzoom;
}
