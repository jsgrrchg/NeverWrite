import fs from "node:fs";
import path from "node:path";

import { createStaticAppcastManifest } from "./appcast-lib.mjs";

function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/validate-appcast-manifest.mjs <path-to-latest.json>");
    process.exit(1);
  }

  const absolutePath = path.resolve(manifestPath);
  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  createStaticAppcastManifest({
    version: raw.version,
    notes: raw.notes,
    pubDate: raw.pub_date,
    platforms: raw.platforms,
  });

  console.log(`Appcast manifest is valid: ${absolutePath}`);
}

main();
