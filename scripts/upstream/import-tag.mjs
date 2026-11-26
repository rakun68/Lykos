#!/usr/bin/env node
// Copies the Pi closure packages and LICENSE (as LICENSE-PI) from a Pi git checkout at a given tag
// onto the local `upstream` branch, unmodified and byte-identical.
//
// Usage: node scripts/upstream/import-tag.mjs --pi-repo ../Lykos_Dev/references/pi --tag v1.6.1

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CLOSURE_PACKAGES = [
	"coding-agent",
	"agent",
	"ai",
	"schema",
	"telemetry",
	"codemode",
	"mcp",
	"tui",
];

function parseArgs(argv) {
	let piRepo = "../Lykos_Dev/references/pi";
	let tag = "v1.6.1";
	let branch = "upstream";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pi-repo" && argv[i + 1]) {
			piRepo = argv[++i];
		} else if (arg === "--tag" && argv[i + 1]) {
			tag = argv[++i];
		} else if (arg === "--branch" && argv[i + 1]) {
			branch = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { piRepo: resolve(piRepo), tag, branch };
}

export function importTagToUpstream({ piRepo, tag, branch = "upstream", repoRoot = process.cwd() }) {
	const piCommit = execFileSync("git", ["-C", piRepo, "rev-parse", `${tag}^{commit}`], {
		encoding: "utf8",
	}).trim();

	const tmp = mkdtempSync(join(tmpdir(), "lykos-upstream-"));
	try {
		const tarPath = join(tmp, "pi.tar");
		execFileSync("git", [
			"-C",
			piRepo,
			"archive",
			"--format=tar",
			"-o",
			tarPath,
			tag,
			"LICENSE",
			...CLOSURE_PACKAGES.map((p) => `packages/${p}`),
		]);

		const workDir = join(tmp, "work");
		mkdirSync(workDir);
		execFileSync("tar", ["-xf", tarPath, "-C", workDir]);
		copyFileSync(join(workDir, "LICENSE"), join(workDir, "LICENSE-PI"));
		rmSync(join(workDir, "LICENSE"));

		const indexFile = join(tmp, "index");
		const env = { ...process.env, GIT_INDEX_FILE: indexFile };
		execFileSync(
			"git",
			["-C", repoRoot, "-c", "core.autocrlf=false", "--work-tree", workDir, "add", "-A"],
			{ env },
		);
		const tree = execFileSync("git", ["-C", repoRoot, "write-tree"], {
			env,
			encoding: "utf8",
		}).trim();

		// Check if the branch already exists; if its tree is identical, keep it idempotent.
		let parentHash = null;
		try {
			parentHash = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			parentHash = null;
		}

		if (parentHash) {
			const existingTree = execFileSync("git", ["-C", repoRoot, "rev-parse", `${parentHash}^{tree}`], {
				encoding: "utf8",
			}).trim();
			if (existingTree === tree) {
				return { piCommit, upstreamCommit: parentHash, tree, changed: false };
			}
		}

		const msg = [
			`Import Pi ${tag} (${piCommit}) unmodified`,
			"",
			`Closure packages: ${CLOSURE_PACKAGES.join(", ")}, plus LICENSE as LICENSE-PI.`,
			"",
			"Co-Authored-By: DeepSeek <noreply@deepseek.com>",
			"Co-Authored-By: Claude <noreply@anthropic.com>",
		].join("\n");

		const commitArgs = ["-C", repoRoot, "commit-tree", tree];
		if (parentHash) {
			commitArgs.push("-p", parentHash);
		}
		commitArgs.push("-m", msg);
		const commitHash = execFileSync("git", commitArgs, { encoding: "utf8" }).trim();
		execFileSync("git", ["-C", repoRoot, "update-ref", `refs/heads/${branch}`, commitHash]);
		return { piCommit, upstreamCommit: commitHash, tree, changed: true };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("import-tag.mjs")) {
	const opts = parseArgs(process.argv.slice(2));
	const result = importTagToUpstream(opts);
	console.log(
		`upstream (${opts.branch}) at ${result.upstreamCommit} (tree ${result.tree}, Pi ${opts.tag} = ${result.piCommit}, changed=${result.changed})`,
	);
}
