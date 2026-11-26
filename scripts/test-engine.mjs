#!/usr/bin/env node
// Runs the engine workspace test suites across all 8 packages.
// Optional filter: pass package directory names as arguments (e.g. `node scripts/test-engine.mjs telemetry schema`).

import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const ALL_PACKAGES = ["telemetry", "schema", "tui", "codemode", "mcp", "ai", "agent", "coding-agent"];
const requested = process.argv.slice(2);
const packages = requested.length > 0 ? requested : ALL_PACKAGES;

const failures = [];

for (const dir of packages) {
	const pkgDir = join(repoRoot, "packages", dir);
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	console.log(`\n[test:engine] === packages/${dir} (${pkgJson.name}) ===`);

	let result;
	if (dir === "tui") {
		// Expand glob in Node so Windows cmd.exe does not pass literal "test/*.test.ts".
		const testFiles = globSync("test/*.test.ts", { cwd: pkgDir }).sort();
		result = spawnSync(
			process.execPath,
			["--test", "--test-reporter=dot", "--test-reporter-destination=stdout", ...testFiles],
			{ cwd: pkgDir, stdio: "inherit" },
		);
	} else {
		result = spawnSync(npmCmd, ["run", "test"], {
			cwd: pkgDir,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
	}

	if (result.status !== 0) {
		failures.push({ dir, name: pkgJson.name, status: result.status });
	}
}

if (failures.length > 0) {
	console.error("\n[test:engine] FAILED packages:");
	for (const f of failures) {
		console.error(`  - packages/${f.dir} (${f.name}): exit ${f.status}`);
	}
	process.exit(1);
}

console.log(`\n[test:engine] PASSED (${packages.length} packages).`);
