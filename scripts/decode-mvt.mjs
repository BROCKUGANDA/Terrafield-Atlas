import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const path = process.argv[2] ?? '/tmp/zam.mvt';
const buf = gunzipSync(readFileSync(path));
const tile = new VectorTile(new PbfReader(buf));
console.log('layers:', Object.keys(tile.layers));
for (const name of Object.keys(tile.layers)) {
  const l = tile.layers[name];
  console.log(`layer=${name} extent=${l.extent} length=${l.length}`);
  for (let i = 0; i < Math.min(5, l.length); i++) {
    const f = l.feature(i);
    console.log('  feature', i, 'type', f.type, 'props', JSON.stringify(f.properties));
    const geom = f.loadGeometry();
    console.log('  first geom pt:', JSON.stringify(geom[0]?.[0]));
  }
}
