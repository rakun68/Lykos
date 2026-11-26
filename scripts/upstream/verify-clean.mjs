#!/usr/bin/env node
// Verifies that no file under `packages/` matches banned Pi patterns or calls `pi.dev`.
// Usage: node scripts/upstream/verify-clean.mjs

import { globSync, readFileSync, statSync } from "node:fs";

const BINARY_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".ico",
	".wasm",
	".node",
	".pdf",
	".zip",
	".gz",
	".tar",
	".bin",
	".c",
	".h",
	".m",
]);

// Files where Greek mathematical `\pi` / `π` is part of the LaTeX renderer / test fixtures.
const LATEX_MATH_FILES = new Set([
	"packages/tui/src/latex.ts",
	"packages/tui/test/latex.test.ts",
	"packages/tui/test/markdown.test.ts",
]);

const CHECKS = [
	{ name: "\\.pi\\b", re: /\.pi\b/ },
	{ name: "~\\/\\.pi", re: /~\/\.pi/ },
	{ name: "\\bPI_[A-Z]", re: /\bPI_[A-Z]/ },
	{ name: "@earendil-works", re: /@earendil-works/i },
	{ name: "@mariozechner", re: /@mariozechner/i },
	{ name: "pi\\.dev", re: /pi\.dev/i },
	{ name: "\\bpi\\b", re: /\bpi\b/i },
	{ name: "π", re: /π/ },
];

export function verifyCleanPackages(repoRoot = process.cwd()) {
	const files = globSync("packages/**/*", {
		cwd: repoRoot,
		nodir: true,
		ignore: [
			"**/node_modules/**",
			"**/dist/**",
			"packages/ai/src/providers/data/**",
			"packages/ai/src/providers/.model-generation-*/**",
		],
	}).sort();

	const violations = [];

	let checkedFiles = 0;

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
		const full = `${repoRoot}/${file}`;
		if (!statSync(full).isFile()) continue;
		const dot = file.lastIndexOf(".");
		if (dot !== -1 && BINARY_EXTS.has(file.slice(dot).toLowerCase())) continue;

		checkedFiles++;
		const content = readFileSync(full, "utf8");
		const lines = content.split(/\r?\n/);
		const isLatexMath = LATEX_MATH_FILES.has(file);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Mask JavaScript `Math.PI` before checking `\bpi\b`.
			let scrubbed = line.replaceAll("Math.PI", "Math.__MATH_CONST__");
			if (isLatexMath) {
				// Mask LaTeX Greek letter `\pi`, `pi: "π"`, and math `π`.
				scrubbed = scrubbed
					.replaceAll("\\pi", "\\__LATEX_CONST__")
					.replace(/\bpi:\s*"π"/g, "__LATEX_KEY__: \"__LATEX_SYM__\"")
					.replaceAll("π", "__LATEX_SYM__");
			}

			for (const check of CHECKS) {
				if (check.re.test(scrubbed)) {
					violations.push({
						file,
						line: i + 1,
						rule: check.name,
						text: line.trim().slice(0, 140),
					});
					break;
				}
			}
		}
	}

	return { checkedFiles, violations };
}

if (process.argv[1]?.endsWith("verify-clean.mjs")) {
	const { checkedFiles, violations } = verifyCleanPackages();
	if (violations.length > 0) {
		console.error(`Clean-tree verification FAILED: ${violations.length} violations across ${checkedFiles} files:`);
		for (const v of violations.slice(0, 100)) {
			console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
		}
		if (violations.length > 100) {
			console.error(`  ... and ${violations.length - 100} more.`);
		}
		process.exit(1);
	}
	console.log(`Clean-tree verification PASSED: ${checkedFiles} files checked under packages/, 0 violations.`);
}
