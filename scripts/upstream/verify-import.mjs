#!/usr/bin/env node
// Verifies that an import commit (default: `upstream`) matches the Pi tag file for file
// under `packages/` (for the 8 closure packages) and that `LICENSE-PI` matches Pi's `LICENSE`.
//
// Usage: node scripts/upstream/verify-import.mjs --pi-repo ../Lykos_Dev/references/pi --tag v1.6.1 --ref upstream

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CLOSURE_PACKAGES } from "./import-tag.mjs";

function parseArgs(argv) {
	let piRepo = "../Lykos_Dev/references/pi";
	let tag = "v1.6.1";
	let ref = "upstream";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pi-repo" && argv[i + 1]) {
			piRepo = argv[++i];
		} else if (arg === "--tag" && argv[i + 1]) {
			tag = argv[++i];
		} else if (arg === "--ref" && argv[i + 1]) {
			ref = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { piRepo: resolve(piRepo), tag, ref };
}

function listTree(cwd, ref, paths) {
	const out = execFileSync("git", ["-C", cwd, "ls-tree", "-r", ref, "--", ...paths], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const entries = new Map();
	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		const [meta, filePath] = line.split("\t");
		const [mode, type, hash] = meta.split(" ");
		if (type !== "blob") continue;
		entries.set(filePath, { mode, hash });
	}
	return entries;
}

const { piRepo, tag, ref } = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

const piPackages = listTree(
	piRepo,
	tag,
	CLOSURE_PACKAGES.map((p) => `packages/${p}`),
);
const localPackages = listTree(repoRoot, ref, ["packages"]);

const errors = [];
for (const [path, expected] of piPackages) {
	const actual = localPackages.get(path);
	if (!actual) {
		errors.push(`Missing in ${ref}: ${path}`);
	} else if (actual.hash !== expected.hash) {
		errors.push(`Content mismatch for ${path}: expected ${expected.hash}, got ${actual.hash}`);
	}
}
for (const path of localPackages.keys()) {
	if (!piPackages.has(path)) {
		errors.push(`Extra file in ${ref}: ${path}`);
	}
}

const piLicense = listTree(piRepo, tag, ["LICENSE"]).get("LICENSE");
const localLicense = listTree(repoRoot, ref, ["LICENSE-PI"]).get("LICENSE-PI");
if (!piLicense) {
	errors.push(`Missing LICENSE in ${piRepo}@${tag}`);
} else if (!localLicense) {
	errors.push(`Missing LICENSE-PI in ${ref}`);
} else if (piLicense.hash !== localLicense.hash) {
	errors.push(`LICENSE-PI mismatch: expected ${piLicense.hash}, got ${localLicense.hash}`);
}

if (errors.length > 0) {
	console.error(`Import verification FAILED (${errors.length} issues):`);
	for (const err of errors.slice(0, 50)) {
		console.error(`  - ${err}`);
	}
	process.exit(1);
}

console.log(
	`Import verification PASSED: ${piPackages.size} files under packages/ and LICENSE-PI in ${ref} match ${tag} byte for byte.`,
);
