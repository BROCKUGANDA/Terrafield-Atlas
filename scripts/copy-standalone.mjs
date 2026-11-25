// Copy .next/static and public/ into the standalone output (cross-platform).
// Next.js standalone mode does not copy these assets automatically.
import { cpSync, existsSync } from "node:fs";

const staticSrc = ".next/static";
const staticDest = ".next/standalone/.next/static";
const publicSrc = "public";
const publicDest = ".next/standalone/public";

if (!existsSync(".next/standalone")) {
  console.error("No .next/standalone found — run `next build` first.");
  process.exit(1);
}

for (const [src, dest] of [[staticSrc, staticDest], [publicSrc, publicDest]]) {
  if (!existsSync(src)) {
    console.warn(`Skipping ${src} (not found)`);
    continue;
  }
  cpSync(src, dest, { recursive: true });
  console.log(`Copied ${src} -> ${dest}`);
}
