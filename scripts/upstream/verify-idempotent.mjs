#!/usr/bin/env node
// Verifies two #64 acceptance criteria against `scripts/upstream/sync.mjs`:
//   1. Running `sync.mjs` twice on the same tag produces byte-identical trees under `packages/` and `LICENSE-PI`.
//   2. A failing patch stops the run with non-zero exit code and names the failing patch.
//
// Usage: node scripts/upstream/verify-idempotent.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const syncScript = join(scriptDir, "sync.mjs");

function hashTree() {
	const files = globSync("packages/**/*", { cwd: repoRoot }).sort();
	const hashes = new Map();
	for (const rawFile of files) {
		const file = rawFile.replaceAll("\\", "/");
		if (
			file.includes("/node_modules/") ||
			file.includes("/dist/") ||
			file.startsWith("packages/ai/src/providers/data/") ||
			file.includes("/.model-generation-")
		) {
			continue;
		}
		const full = join(repoRoot, file);
		if (!statSync(full).isFile()) continue;
		const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
		hashes.set(file, digest);
	}
	hashes.set("LICENSE-PI", createHash("sha256").update(readFileSync(join(repoRoot, "LICENSE-PI"))).digest("hex"));
	return hashes;
}

console.log("[verify] Run 1 of sync.mjs...");
execFileSync(process.execPath, [syncScript], { cwd: repoRoot, stdio: "inherit" });
const run1 = hashTree();

console.log("\n[verify] Run 2 of sync.mjs...");
execFileSync(process.execPath, [syncScript], { cwd: repoRoot, stdio: "inherit" });
const run2 = hashTree();

const diffs = [];
for (const [file, digest] of run1) {
	if (run2.get(file) !== digest) diffs.push(`Changed: ${file}`);
}
for (const file of run2.keys()) {
	if (!run1.has(file)) diffs.push(`Added: ${file}`);
}
if (diffs.length > 0) {
	console.error(`Idempotency FAILED (${diffs.length} differences):`, diffs.slice(0, 20));
	process.exit(1);
}
console.log(`\n[verify] Idempotency PASSED: ${run1.size} files byte-identical across two runs.`);

// Test failing patch behavior
const badPatchName = "9999-intentional-fail-test.patch";
const badPatchPath = join(scriptDir, "patches", badPatchName);
writeFileSync(
	badPatchPath,
	[
		"diff --git a/packages/coding-agent/src/index.ts b/packages/coding-agent/src/index.ts",
		"--- a/packages/coding-agent/src/index.ts",
		"+++ b/packages/coding-agent/src/index.ts",
		"@@ -1,3 +1,3 @@",
		"-THIS LINE DOES NOT EXIST IN INDEX.TS",
		"+REPLACEMENT LINE",
		"",
	].join("\n"),
	"utf8",
);

try {
	console.log(`\n[verify] Testing failing patch (${badPatchName})...`);
	const res = spawnSync(process.execPath, [syncScript], { cwd: repoRoot, encoding: "utf8" });
	const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
	if (res.status === 0) {
		console.error("Failing-patch check FAILED: sync.mjs exited 0 on a broken patch!");
		process.exit(1);
	}
	if (!combined.includes(badPatchName)) {
		console.error(`Failing-patch check FAILED: output did not name ${badPatchName}:\n${combined}`);
		process.exit(1);
	}
	console.log(`[verify] Failing-patch check PASSED: exit=${res.status}, named ${badPatchName}.`);
} finally {
	rmSync(badPatchPath, { force: true });
}

// Restore clean post-sync state
console.log("\n[verify] Restoring clean post-sync tree...");
execFileSync(process.execPath, [syncScript], { cwd: repoRoot, stdio: "inherit" });
