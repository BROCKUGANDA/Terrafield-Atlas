/**
 * Curated demonstration regions for the public demo route.
 *
 * HONESTY NOTE: this is a curated preset list of real agricultural regions
 * (real names, real coordinates), provided so judges can explore without
 * locating themselves. It is NOT an administrative-boundary dataset, and it is
 * labeled as such in the UI ("curated demo presets"). The map itself uses
 * real NASA GIBS imagery of these locations.
 */

export interface RegionPreset {
  key: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  croppingContext: string;
  typicalCrops: string[];
}

export const REGION_PRESETS: RegionPreset[] = [
  {
    key: 'nakuru',
    name: 'Nakuru County — Rift Valley highlands',
    country: 'Kenya',
    lat: -0.28,
    lon: 36.07,
    croppingContext: 'Highland mixed maize–dairy smallholdings; two rainy seasons (Mar–May "long rains", Oct–Dec "short rains"); acidic volcanic soils common.',
    typicalCrops: ['maize', 'common_bean', 'potato', 'cowpea'],
  },
  {
    key: 'iowa',
    name: 'Central Iowa — Corn Belt',
    country: 'United States',
    lat: 41.88,
    lon: -93.1,
    croppingContext: 'Large-scale maize–soybean rotation on deep Mollisols; fully mechanised, rainfed with ~870 mm annual precipitation.',
    typicalCrops: ['maize', 'soybean'],
  },
  {
    key: 'punjab',
    name: 'Punjab — Indo-Gangetic plains',
    country: 'India',
    lat: 30.9,
    lon: 75.85,
    croppingContext: 'Intensive rice–wheat double-cropping with irrigation; documented groundwater depletion and soil-health concerns; monsoon Jun–Sep.',
    typicalCrops: ['wheat', 'rice-irrigated (not in catalogue)', 'maize', 'potato'],
  },
  {
    key: 'saskatchewan',
    name: 'Saskatchewan — Prairie parkland',
    country: 'Canada',
    lat: 51.35,
    lon: -105.5,
    croppingContext: 'Short-season spring wheat–canola–pulse rotations; cold-limited season; semi-arid continental climate.',
    typicalCrops: ['wheat', 'barley', 'chickpea'],
  },
  {
    key: 'cordoba',
    name: 'Córdoba — Pampas core',
    country: 'Argentina',
    lat: -33.1,
    lon: -63.2,
    croppingContext: 'No-till soybean–maize–wheat rotations; 800–950 mm annual precipitation concentrated in warm months.',
    typicalCrops: ['soybean', 'maize', 'wheat', 'sunflower'],
  },
  {
    key: 'wa-wheatbelt',
    name: 'Western Australia — Wheatbelt',
    country: 'Australia',
    lat: -31.6,
    lon: 117.3,
    croppingContext: 'Mediterranean climate (winter rainfall); wheat–lupin/legume rotations on ancient duplex soils; pronounced autumn/winter planting window.',
    typicalCrops: ['wheat', 'barley', 'common_bean', 'sweet_potato'],
  },
  {
    key: 'zambia-central',
    name: 'Central Province — maize belt',
    country: 'Zambia',
    lat: -14.3,
    lon: 28.1,
    croppingContext: 'Unimodal wet season Nov–Mar; maize-dominated smallholder systems; strong dry-season fire activity in surrounding miombo woodland.',
    typicalCrops: ['maize', 'groundnut', 'cowpea', 'sunflower'],
  },
  {
    key: 'normandy',
    name: 'Normandy — Atlantic mixed farming',
    country: 'France',
    lat: 49.3,
    lon: -0.4,
    croppingContext: 'Temperate mixed crop–livestock; wheat–barley rotations with high organic-matter soils; year-round rainfall.',
    typicalCrops: ['wheat', 'barley', 'potato', 'sunflower'],
  },
];
