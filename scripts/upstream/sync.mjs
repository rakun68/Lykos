#!/usr/bin/env node
// Turns an upstream Pi tag into Lykos source under `packages/`.
// Idempotent: running twice on the same tag produces byte-identical trees.
//
// Pipeline:
//   1. (Optional) Copy closure from `--pi-repo` at `--tag` onto the `upstream` branch.
//   2. Restore `packages/` and `LICENSE-PI` cleanly from `upstream`.
//   3. Drop self-update, installer, share viewer, Pi's CLI main, docs/examples/changelogs, and their tests.
//   4. Mechanically rename Pi package names, paths, env vars, identifiers, filenames, and strings to Lykos.
//   5. Apply patches in `scripts/upstream/patches/` in sorted order (stops and names any failing patch).
//   6. Verify no file under `packages/` matches banned Pi patterns or calls `pi.dev`.
//
// Usage:
//   node scripts/upstream/sync.mjs [--pi-repo ../Lykos_Dev/references/pi --tag v1.6.1] [--branch upstream] [--skip-verify]

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { importTagToUpstream } from "./import-tag.mjs";
import { verifyCleanPackages } from "./verify-clean.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const patchesDir = join(scriptDir, "patches");

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

const LATEX_MATH_FILES = new Set([
	"packages/tui/src/latex.ts",
	"packages/tui/test/latex.test.ts",
	"packages/tui/test/markdown.test.ts",
]);

// Paths dropped on every upstream import (relative to repoRoot).
const DROP_PATHS = [
	// Self-update, version-check, installer, and Pi CLI package-manager
	"packages/coding-agent/src/utils/windows-self-update.ts",
	"packages/coding-agent/src/utils/version-check.ts",
	"packages/coding-agent/src/package-manager-cli.ts",
	"packages/coding-agent/test/version-check.test.ts",
	"packages/coding-agent/test/package-command-paths.test.ts",
	// Share viewer
	"packages/coding-agent/src/modes/interactive/session-share.ts",
	"packages/coding-agent/test/session-share.test.ts",
	"packages/coding-agent/test/export-jsonl-share.test.ts",
	// Pi's CLI main and standalone CLI entrypoints
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/rpc-entry.ts",
	"packages/coding-agent/src/bun",
	"packages/coding-agent/src/cli/setup.ts",
	"packages/ai/src/cli.ts",
	// Tests that invoke Pi's dropped CLI main / cli.ts directly
	"packages/coding-agent/test/args.test.ts",
	"packages/coding-agent/test/credential-print.test.ts",
	"packages/coding-agent/test/deleted-cwd.test.ts",
	"packages/coding-agent/test/interactive-mode-status.test.ts",
	"packages/coding-agent/test/mcp-command.test.ts",
	"packages/coding-agent/test/model-fallback-diagnostic.test.ts",
	"packages/coding-agent/test/model-scope-session-replacement.test.ts",
	"packages/coding-agent/test/project-trust-saved-decision.test.ts",
	"packages/coding-agent/test/rpc-replacement-diagnostics.test.ts",
	"packages/coding-agent/test/session-file-invalid.test.ts",
	"packages/coding-agent/test/session-id-readonly.test.ts",
	"packages/coding-agent/test/startup-session-name.test.ts",
	"packages/coding-agent/test/stdout-cleanliness.test.ts",
	"packages/coding-agent/test/suite/agent-session-mcp-oauth.test.ts",
	// Pi docs, examples, and changelogs (and tests that read them)
	"packages/coding-agent/docs",
	"packages/coding-agent/examples",
	"packages/agent/examples",
	"packages/coding-agent/tsconfig.examples.json",
	"packages/coding-agent/install-lock",
	"packages/coding-agent/test/documentation.test.ts",
	"packages/coding-agent/test/changelog.test.ts",
	"packages/coding-agent/test/compaction-extensions-example.test.ts",
	"packages/coding-agent/test/git-merge-and-resolve-extension.test.ts",
	"packages/coding-agent/test/input-transform-streaming-example.test.ts",
	"packages/coding-agent/test/jev-router-example.test.ts",
	"packages/coding-agent/test/plan-mode-extension.test.ts",
	"packages/coding-agent/test/plan-mode-utils.test.ts",
	"packages/coding-agent/test/subagent-extension.test.ts",
	"packages/coding-agent/test/tool-renderer-examples.test.ts",
	"packages/coding-agent/test/trigger-compact-extension.test.ts",
	"packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts",
	"packages/coding-agent/test/remote-catalog-provider.test.ts",
	"packages/coding-agent/test/model-catalog-protocol.test.ts",
	"packages/coding-agent/test/mcp-oauth-refresh.test.ts",
	// Schema benchmark suite (depends on @oh-my-pi/omptype)
	"packages/schema/test/bench",
];

// Explicit file renames (source -> target, relative to repoRoot).
const FILE_RENAMES = [
	["packages/ai/src/api/pi-decision.lazy.ts", "packages/ai/src/api/lykos-decision.lazy.ts"],
	["packages/ai/src/api/pi-decision.ts", "packages/ai/src/api/lykos-decision.ts"],
	["packages/ai/src/api/pi-messages.lazy.ts", "packages/ai/src/api/lykos-messages.lazy.ts"],
	["packages/ai/src/api/pi-messages.ts", "packages/ai/src/api/lykos-messages.ts"],
	["packages/ai/test/pi-decision.test.ts", "packages/ai/test/lykos-decision.test.ts"],
	["packages/ai/test/pi-messages.test.ts", "packages/ai/test/lykos-messages.test.ts"],
	[
		"packages/coding-agent/src/core/extensions/pi-ai-extension-view.ts",
		"packages/coding-agent/src/core/extensions/lykos-ai-extension-view.ts",
	],
	["packages/coding-agent/src/core/pi-ai-schemas.ts", "packages/coding-agent/src/core/lykos-ai-schemas.ts"],
	["packages/coding-agent/src/core/pi-manifest.ts", "packages/coding-agent/src/core/lykos-manifest.ts"],
	[
		"packages/coding-agent/src/modes/interactive/components/pi-logo.ts",
		"packages/coding-agent/src/modes/interactive/components/lykos-logo.ts",
	],
	["packages/coding-agent/src/utils/pi-user-agent.ts", "packages/coding-agent/src/utils/lykos-user-agent.ts"],
	["packages/coding-agent/test/pi-user-agent.test.ts", "packages/coding-agent/test/lykos-user-agent.test.ts"],
	[
		"packages/coding-agent/test/suite/regressions/11156-pi-ai-models-virtual-module.test.ts",
		"packages/coding-agent/test/suite/regressions/11156-lykos-ai-models-virtual-module.test.ts",
	],
	[
		"packages/coding-agent/test/suite/regressions/11264-pi-events-handler-errors.test.ts",
		"packages/coding-agent/test/suite/regressions/11264-lykos-events-handler-errors.test.ts",
	],
];

// Ordered mechanical text replacements applied to every non-binary text file under `packages/`.
const REPLACEMENTS = [
	// Scoped package names (both normal `/` and regex-escaped `\/`, most specific first)
	[/@earendil-works\\\/pi-coding-agent/g, "@lykos\\/coding-agent"],
	[/@earendil-works\\\/pi-agent-core/g, "@lykos\\/agent-core"],
	[/@earendil-works\\\/pi-ai/g, "@lykos\\/ai"],
	[/@earendil-works\\\/pi-schema/g, "@lykos\\/schema"],
	[/@earendil-works\\\/pi-telemetry/g, "@lykos\\/telemetry"],
	[/@earendil-works\\\/pi-codemode/g, "@lykos\\/codemode"],
	[/@earendil-works\\\/pi-mcp/g, "@lykos\\/mcp"],
	[/@earendil-works\\\/pi-tui/g, "@lykos\\/tui"],
	[/@earendil-works\\\/pi-/g, "@lykos\\/"],
	[/@earendil-works\\\//g, "@lykos\\/"],
	[/@mariozechner\\\/pi-coding-agent/g, "@lykos\\/coding-agent"],
	[/@mariozechner\\\/pi-agent-core/g, "@lykos\\/agent-core"],
	[/@mariozechner\\\/pi-ai/g, "@lykos\\/ai"],
	[/@mariozechner\\\/pi-tui/g, "@lykos\\/tui"],
	[/@mariozechner\\\/pi-/g, "@lykos\\/"],
	[/@mariozechner\\\//g, "@lykos\\/"],
	[/@earendil-works\/pi-coding-agent/g, "@lykos/coding-agent"],
	[/@earendil-works\/pi-agent-core/g, "@lykos/agent-core"],
	[/@earendil-works\/pi-ai/g, "@lykos/ai"],
	[/@earendil-works\/pi-schema/g, "@lykos/schema"],
	[/@earendil-works\/pi-telemetry/g, "@lykos/telemetry"],
	[/@earendil-works\/pi-codemode/g, "@lykos/codemode"],
	[/@earendil-works\/pi-mcp/g, "@lykos/mcp"],
	[/@earendil-works\/pi-tui/g, "@lykos/tui"],
	[/@earendil-works\/pi-/g, "@lykos/"],
	[/@earendil-works\//g, "@lykos/"],
	[/@mariozechner\/pi-coding-agent/g, "@lykos/coding-agent"],
	[/@mariozechner\/pi-agent-core/g, "@lykos/agent-core"],
	[/@mariozechner\/pi-ai/g, "@lykos/ai"],
	[/@mariozechner\/pi-tui/g, "@lykos/tui"],
	[/@mariozechner\/pi-/g, "@lykos/"],
	[/@mariozechner\//g, "@lykos/"],
	[/@earendil-works\b/g, "@lykos"],
	[/@mariozechner\b/g, "@lykos"],

	// GitHub repository URLs
	[/https:\/\/github\.com\/earendil-works\/pi/g, "https://github.com/rakun68/Lykos"],
	[/github\.com\/earendil-works\/pi/g, "github.com/rakun68/Lykos"],

	// pi.dev URLs (must run before `.pi` path replacement)
	[/https?:\/\/(?:[a-z0-9-]+\.)?pi\.dev\b/gi, "https://lykos.local"],
	[/\bpi\.dev\b/gi, "lykos.local"],

	// Config paths: ~/.pi/agent -> ~/.lykos, .pi/ -> .lykos/, ".pi" -> ".lykos"
	[/~\/\.pi\/agent\b/g, "~/.lykos"],
	[/~\\\.pi\\agent\b/g, "~\\.lykos"],
	[/\/\.pi\/agent\b/g, "/.lykos"],
	[/\\\.pi\\agent\b/g, "\\.lykos"],
	[/~\/\.pi\b/g, "~/.lykos"],
	[/~\\\.pi\b/g, "~\\.lykos"],
	[/\.pi\b/g, ".lykos"],

	// Environment variables: PI_* -> LYKOS_*
	[/\bPI_([A-Z0-9_]+)\b/g, "LYKOS_$1"],

	// Renamed file paths / import specifiers
	[/\bpi-decision\.lazy\b/g, "lykos-decision.lazy"],
	[/\bpi-decision\b/g, "lykos-decision"],
	[/\bpi-messages\.lazy\b/g, "lykos-messages.lazy"],
	[/\bpi-messages\b/g, "lykos-messages"],
	[/\bpi-ai-extension-view\b/g, "lykos-ai-extension-view"],
	[/\bpi-ai-schemas\b/g, "lykos-ai-schemas"],
	[/\bpi-manifest\b/g, "lykos-manifest"],
	[/\bpi-logo\b/g, "lykos-logo"],
	[/\bpi-user-agent\b/g, "lykos-user-agent"],

	// Compound hyphenated and camelCase identifiers
	[/\bpi-coding-agent\b/g, "lykos-coding-agent"],
	[/\bpi-agent-core\b/g, "lykos-agent-core"],
	[/\bpi-ai\b/g, "lykos-ai"],
	[/\bpi-tui\b/g, "lykos-tui"],
	[/\bpi-mcp\b/g, "lykos-mcp"],
	[/\bpi-codemode\b/g, "lykos-codemode"],
	[/\bpi-schema\b/g, "lykos-schema"],
	[/\bpi-telemetry\b/g, "lykos-telemetry"],
	[/\bpi-package\b/g, "lykos-package"],
	[/\bpiConfig\b/g, "lykosConfig"],
	[/\bpiConfigName\b/g, "lykosConfigName"],
	[/\bPiManifest\b/g, "LykosManifest"],
	[/\breadPiManifest\b/g, "readLykosManifest"],
	[/\bgetPiUserAgent\b/g, "getLykosUserAgent"],
	[/\bgetPiDocsClassification\b/g, "getLykosDocsClassification"],
	[/\bpiSettings\b/g, "lykosSettings"],

	// Word-boundary standalone Pi / pi / PI (Math.PI and LaTeX `\pi` are protected per-file)
	[/\bPi\b/g, "Lykos"],
	[/\bPI\b/g, "LYKOS"],
	[/\bpi\b/g, "lykos"],
];

function parseArgs(argv) {
	let piRepo = null;
	let tag = null;
	let branch = "upstream";
	let skipVerify = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pi-repo" && argv[i + 1]) piRepo = resolve(argv[++i]);
		else if (arg === "--tag" && argv[i + 1]) tag = argv[++i];
		else if (arg === "--branch" && argv[i + 1]) branch = argv[++i];
		else if (arg === "--skip-verify") skipVerify = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return { piRepo, tag, branch, skipVerify };
}

function restoreFromUpstream(branch) {
	// Preserve hydrated model data if present (gitignored, avoids re-fetching on every sync).
	const modelDataDir = join(repoRoot, "packages", "ai", "src", "providers", "data");
	let savedModelData = null;
	if (existsSync(modelDataDir)) {
		savedModelData = mkdtempSync(join(tmpdir(), "lykos-model-data-"));
		cpSync(modelDataDir, savedModelData, { recursive: true });
	}

	const tmp = mkdtempSync(join(tmpdir(), "lykos-extract-"));
	try {
		const tarPath = join(tmp, "upstream.tar");
		execFileSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, branch]);
		const extractDir = join(tmp, "tree");
		mkdirSync(extractDir);
		execFileSync("tar", ["-xf", tarPath, "-C", extractDir]);

		// Replace tracked package files cleanly while preserving per-workspace node_modules/ and dist/.
		const packagesDir = join(repoRoot, "packages");
		mkdirSync(packagesDir, { recursive: true });
		for (const pkgName of readdirSync(packagesDir)) {
			const pkgPath = join(packagesDir, pkgName);
			if (!existsSync(join(extractDir, "packages", pkgName))) {
				rmSync(pkgPath, { recursive: true, force: true });
				continue;
			}
			for (const entry of readdirSync(pkgPath)) {
				if (entry === "node_modules" || entry === "dist") continue;
				rmSync(join(pkgPath, entry), { recursive: true, force: true });
			}
		}
		cpSync(join(extractDir, "packages"), packagesDir, { recursive: true });
		cpSync(join(extractDir, "LICENSE-PI"), join(repoRoot, "LICENSE-PI"));

		if (savedModelData) {
			mkdirSync(dirname(modelDataDir), { recursive: true });
			cpSync(savedModelData, modelDataDir, { recursive: true });
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		if (savedModelData) rmSync(savedModelData, { recursive: true, force: true });
	}
}

function dropPaths() {
	let dropped = 0;
	for (const rel of DROP_PATHS) {
		const full = join(repoRoot, rel);
		if (existsSync(full)) {
			rmSync(full, { recursive: true, force: true });
			dropped++;
		}
	}
	// Drop all package CHANGELOG.md files by pattern.
	for (const rel of globSync("packages/*/CHANGELOG.md", { cwd: repoRoot })) {
		rmSync(join(repoRoot, rel), { force: true });
		dropped++;
	}
	return dropped;
}

function renameFiles() {
	let renamed = 0;
	for (const [fromRel, toRel] of FILE_RENAMES) {
		const fromPath = join(repoRoot, fromRel);
		const toPath = join(repoRoot, toRel);
		if (existsSync(fromPath)) {
			mkdirSync(dirname(toPath), { recursive: true });
			renameSync(fromPath, toPath);
			renamed++;
		}
	}
	return renamed;
}

function transformText(content, file) {
	const isLatexMath = LATEX_MATH_FILES.has(file);
	const MATH_PI_TOKEN = "__LYKOS_PROTECTED_MATH_PI__";
	const LATEX_SLASH_PI_TOKEN = "__LYKOS_PROTECTED_LATEX_SLASH_PI__";
	const LATEX_KEY_TOKEN = "__LYKOS_PROTECTED_LATEX_KEY__";
	const LATEX_SYM_TOKEN = "__LYKOS_PROTECTED_LATEX_SYM__";

	let text = content.replaceAll("Math.PI", MATH_PI_TOKEN);
	if (isLatexMath) {
		text = text
			.replaceAll("\\pi", LATEX_SLASH_PI_TOKEN)
			.replace(/\bpi:\s*"π"/g, LATEX_KEY_TOKEN)
			.replaceAll("π", LATEX_SYM_TOKEN);
	}

	for (const [re, replacement] of REPLACEMENTS) {
		text = text.replace(re, replacement);
	}

	if (!isLatexMath) {
		text = text.replaceAll("π", "lykos");
	}

	text = text.replaceAll(MATH_PI_TOKEN, "Math.PI");
	if (isLatexMath) {
		text = text
			.replaceAll(LATEX_SLASH_PI_TOKEN, "\\pi")
			.replaceAll(LATEX_KEY_TOKEN, 'pi: "π"')
			.replaceAll(LATEX_SYM_TOKEN, "π");
	}
	return text;
}

function renameContents() {
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

	let modified = 0;
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
		const dot = file.lastIndexOf(".");
		if (dot !== -1 && BINARY_EXTS.has(file.slice(dot).toLowerCase())) continue;

		const full = join(repoRoot, file);
		if (!statSync(full).isFile()) continue;
		const orig = readFileSync(full, "utf8");
		const next = transformText(orig, file);
		if (next !== orig) {
			writeFileSync(full, next, "utf8");
			modified++;
		}
	}
	return modified;
}

function cleanPackageJsonFiles() {
	// packages/coding-agent/package.json: set lykosConfig, drop bin, drop cli.js/rpc-entry.js from build:unbundled
	const codingAgentPkgPath = join(repoRoot, "packages", "coding-agent", "package.json");
	const codingAgentPkg = JSON.parse(readFileSync(codingAgentPkgPath, "utf8"));
	codingAgentPkg.lykosConfig = { name: "lykos", configDir: ".lykos" };
	delete codingAgentPkg.bin;
	if (codingAgentPkg.exports && "./rpc-entry" in codingAgentPkg.exports) {
		delete codingAgentPkg.exports["./rpc-entry"];
	}
	if (codingAgentPkg.scripts?.["build:unbundled"]) {
		codingAgentPkg.scripts["build:unbundled"] = "tsc -p tsconfig.build.json && npm run copy-assets";
	}
	writeFileSync(codingAgentPkgPath, `${JSON.stringify(codingAgentPkg, null, "\t")}\n`, "utf8");

	// packages/ai/package.json: drop bin (cli.ts was dropped)
	const aiPkgPath = join(repoRoot, "packages", "ai", "package.json");
	const aiPkg = JSON.parse(readFileSync(aiPkgPath, "utf8"));
	delete aiPkg.bin;
	writeFileSync(aiPkgPath, `${JSON.stringify(aiPkg, null, "\t")}\n`, "utf8");

	// packages/schema/package.json: drop benchmark-only @oh-my-pi/omptype devDependency
	const schemaPkgPath = join(repoRoot, "packages", "schema", "package.json");
	const schemaPkg = JSON.parse(readFileSync(schemaPkgPath, "utf8"));
	if (schemaPkg.devDependencies) {
		delete schemaPkg.devDependencies["@oh-my-lykos/omptype"];
		delete schemaPkg.devDependencies["@oh-my-pi/omptype"];
	}
	writeFileSync(schemaPkgPath, `${JSON.stringify(schemaPkg, null, "\t")}\n`, "utf8");
}

function applyPatches() {
	if (!existsSync(patchesDir)) return 0;
	const patchFiles = readdirSync(patchesDir)
		.filter((name) => name.endsWith(".patch"))
		.sort();

	for (const name of patchFiles) {
		const patchPath = join(patchesDir, name);
		try {
			execFileSync("git", ["-C", repoRoot, "apply", "--check", "--whitespace=nowarn", patchPath], {
				stdio: "pipe",
			});
		} catch (error) {
			const stderr = error.stderr ? error.stderr.toString("utf8").trim() : String(error);
			console.error(`\nPatch failed to apply: scripts/upstream/patches/${name}`);
			if (stderr) console.error(stderr);
			process.exit(1);
		}
		execFileSync("git", ["-C", repoRoot, "apply", "--whitespace=nowarn", patchPath], {
			stdio: "inherit",
		});
		console.log(`[upstream] applied patch: ${name}`);
	}
	return patchFiles.length;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.piRepo && opts.tag) {
	const imported = importTagToUpstream({
		piRepo: opts.piRepo,
		tag: opts.tag,
		branch: opts.branch,
		repoRoot,
	});
	console.log(
		`[upstream] branch ${opts.branch} at ${imported.upstreamCommit} (Pi ${opts.tag} = ${imported.piCommit})`,
	);
}

console.log(`[upstream] restoring packages/ from ${opts.branch}...`);
restoreFromUpstream(opts.branch);

const dropped = dropPaths();
console.log(`[upstream] dropped ${dropped} paths.`);

const renamedFiles = renameFiles();
console.log(`[upstream] renamed ${renamedFiles} files.`);

const modifiedFiles = renameContents();
cleanPackageJsonFiles();
console.log(`[upstream] renamed contents in ${modifiedFiles} files.`);

const appliedPatches = applyPatches();
console.log(`[upstream] applied ${appliedPatches} patches.`);

if (!opts.skipVerify) {
	const { checkedFiles, violations } = verifyCleanPackages(repoRoot);
	if (violations.length > 0) {
		console.error(
			`\n[upstream] Clean-tree verification FAILED: ${violations.length} violations across ${checkedFiles} files:`,
		);
		for (const v of violations.slice(0, 60)) {
			console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
		}
		if (violations.length > 60) {
			console.error(`  ... and ${violations.length - 60} more.`);
		}
		process.exit(1);
	}
	console.log(`[upstream] Clean-tree verification PASSED (${checkedFiles} files, 0 violations).`);
}
