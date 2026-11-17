// Runs every *.test.mjs in this folder one after the other (npm test). About 3 minutes.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const files = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs") && (!only || f.includes(only))).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n${failed ? `${failed} of ${files.length} test files FAILED` : `all ${files.length} test files passed`}`);
process.exit(failed ? 1 : 0);
