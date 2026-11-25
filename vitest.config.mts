import { fileURLToPath } from 'node:url';
import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Vitest only runs the CodSpeed benchmarks in bench/. Unit and integration
// tests stay on `bun test`.
export default defineConfig({
  plugins: [codspeedPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: [],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});
