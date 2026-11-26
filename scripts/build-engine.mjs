#!/usr/bin/env node
// Builds all engine workspace packages in dependency order using Lykos's toolchain.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const BUILD_ORDER = [
	{ dir: "telemetry", script: "build" },
	{ dir: "schema", script: "build" },
	{ dir: "tui", script: "build" },
	{ dir: "codemode", script: "build" },
	{ dir: "mcp", script: "build" },
	{ dir: "ai", script: "hydrate-model-data", onlyIfMissing: "src/providers/data/manifest.json" },
	{ dir: "ai", script: "build:offline" },
	{ dir: "agent", script: "build" },
	{ dir: "coding-agent", script: "build:unbundled" },
];

for (const { dir, script, onlyIfMissing } of BUILD_ORDER) {
	const pkgDir = join(repoRoot, "packages", dir);
	if (!existsSync(pkgDir)) {
		throw new Error(`Missing workspace package directory: packages/${dir}`);
	}
	if (onlyIfMissing && existsSync(join(pkgDir, onlyIfMissing))) {
		continue;
	}
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const chosen = pkgJson.scripts?.[script] ? script : "build";
	console.log(`[build:engine] packages/${dir} (${pkgJson.name}) -> npm run ${chosen}`);
	execFileSync(npmCmd, ["run", chosen], {
		cwd: pkgDir,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
}
