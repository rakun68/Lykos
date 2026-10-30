#!/usr/bin/env node
// tsc only emits .js from .ts; prices.yaml and schema.sql are read at runtime
// via readFileSync next to the compiled module, so the build has to copy them
// into dist/ledger alongside ledger.js and prices.js or the published
// binary throws ENOENT the moment it runs outside this source tree.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "lykos", "ledger");
const destDir = join(repoRoot, "dist", "ledger");

mkdirSync(destDir, { recursive: true });
for (const file of ["prices.yaml", "schema.sql", "context-tokens.json"]) {
  copyFileSync(join(srcDir, file), join(destDir, file));
  process.stdout.write(`copied ${file} -> dist/ledger/${file}\n`);
}

// The default container image's Dockerfile is read at runtime too (T173): the
// image tag is a hash of its bytes, and `docker build` needs it on disk.
const imageDest = join(repoRoot, "dist", "containment", "image");
mkdirSync(imageDest, { recursive: true });
copyFileSync(join(repoRoot, "lykos", "containment", "image", "Dockerfile"), join(imageDest, "Dockerfile"));
process.stdout.write("copied Dockerfile -> dist/containment/image/Dockerfile\n");

// Specialists library (ticket 07)
import { readdirSync } from "node:fs";
const specialistsSrc = join(repoRoot, "lykos", "specialists");
const specialistsDest = join(repoRoot, "dist", "specialists");
mkdirSync(specialistsDest, { recursive: true });
for (const file of readdirSync(specialistsSrc)) {
  if (file.endsWith(".yaml")) {
    copyFileSync(join(specialistsSrc, file), join(specialistsDest, file));
    process.stdout.write(`copied ${file} -> dist/specialists/${file}\n`);
  }
}

// Output styles library (T217)
const outputStylesSrc = join(repoRoot, "lykos", "output-styles");
const outputStylesDest = join(repoRoot, "dist", "output-styles");
mkdirSync(outputStylesDest, { recursive: true });
for (const file of readdirSync(outputStylesSrc)) {
  if (file.endsWith(".md")) {
    copyFileSync(join(outputStylesSrc, file), join(outputStylesDest, file));
    process.stdout.write(`copied ${file} -> dist/output-styles/${file}\n`);
  }
}
