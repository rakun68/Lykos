// `lykos run`'s task from `@path` files and piped stdin, so a multi-line task
// never has to cross a command line that a Windows `.cmd` launcher cuts at its
// first newline.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { parseRunBriefArgs, resolveRunBrief, type BriefSources } from "./brief.js";

const TASK = 'Fix D18: a Monday "22:00-02:00" window\ncovers Tuesday 01:00.\n\nDo not commit.\n';

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-brief-"));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body, "utf8");
  return dir;
}

function sources(cwd: string, opts: { tty?: boolean; stdin?: string } = {}): BriefSources & { stdinReads: number } {
  const src = {
    cwd,
    stdinIsTTY: opts.tty ?? true,
    stdinReads: 0,
    readStdin: async () => {
      src.stdinReads += 1;
      return opts.stdin ?? "";
    },
  };
  return src;
}

describe("parseRunBriefArgs", () => {
  it("separates the task, @files and the stdin marker, and skips flag values", () => {
    assert.deepEqual(parseRunBriefArgs(["--model", "@not-a-file", "--yes", "@a.md", "-", "do it", "@b.md", "ignored"]), {
      message: "do it",
      files: ["a.md", "b.md"],
      stdin: true,
    });
  });

  it("after --, the next argument is the task verbatim, even `@x` or `-`", () => {
    assert.deepEqual(parseRunBriefArgs(["--yes", "--", "@mention the owner"]), { message: "@mention the owner", files: [], stdin: false, verbatim: true });
    assert.deepEqual(parseRunBriefArgs(["--", "-"]), { message: "-", files: [], stdin: false, verbatim: true });
  });

  it("strips one pair of quotes a shell left around an @path", () => {
    assert.deepEqual(parseRunBriefArgs(['@"my task.md"']).files, ["my task.md"]);
  });
});

describe("resolveRunBrief", () => {
  it("a lone argument is the task, and stdin is not read", async () => {
    const src = sources(workspace(), { tty: false, stdin: "never" });
    const r = await resolveRunBrief({ message: "do it", files: [], stdin: false }, src);
    assert.deepEqual(r, { brief: "do it", fromStdin: false, files: [], images: [] });
    assert.equal(src.stdinReads, 0, "a harness whose stdin is an open pipe must not be waited on");
  });

  it("an @file arrives whole, newlines and quotes intact, in Pi's <file> block", async () => {
    const dir = workspace({ "task.md": TASK });
    const r = await resolveRunBrief({ files: ["task.md"], stdin: false }, sources(dir));
    assert.ok("brief" in r);
    assert.equal(r.brief, `<file name="${resolve(dir, "task.md")}">\n${TASK}\n</file>`);
  });

  it("piped stdin with nothing else given is the task, whole", async () => {
    const r = await resolveRunBrief({ files: [], stdin: false }, sources(workspace(), { tty: false, stdin: `﻿${TASK}` }));
    assert.deepEqual(r, { brief: TASK.trim(), fromStdin: true, files: [], images: [] });
  });

  it("orders stdin, then files, then the argument, as Pi does", async () => {
    const dir = workspace({ "ctx.md": "context" });
    const r = await resolveRunBrief({ message: "the ask", files: ["ctx.md"], stdin: true }, sources(dir, { tty: false, stdin: "piped" }));
    assert.ok("brief" in r);
    assert.equal(r.brief, `piped\n<file name="${resolve(dir, "ctx.md")}">\ncontext\n</file>\nthe ask`);
  });

  it("an empty @file is skipped, as in Pi", async () => {
    const dir = workspace({ "empty.md": "" });
    const r = await resolveRunBrief({ message: "x", files: ["empty.md"], stdin: false }, sources(dir));
    assert.deepEqual(r, { brief: "x", fromStdin: false, files: [], images: [] });
  });

  it("a missing @file is an error naming it, never a task without it", async () => {
    const r = await resolveRunBrief({ message: "x", files: ["nope.md"], stdin: false }, sources(workspace()));
    assert.ok("error" in r);
    assert.match(r.error, /cannot read @nope\.md .*no such file/);
  });

  it("`-` on a terminal, or with empty stdin, is an error", async () => {
    const tty = await resolveRunBrief({ files: [], stdin: true }, sources(workspace(), { tty: true }));
    assert.ok("error" in tty && /stdin is a terminal/.test(tty.error));
    const empty = await resolveRunBrief({ files: [], stdin: true }, sources(workspace(), { tty: false, stdin: "  \n" }));
    assert.ok("error" in empty && /stdin was empty/.test(empty.error));
  });

  it("nothing at all is the old `expected a brief` error", async () => {
    const r = await resolveRunBrief({ files: [], stdin: false }, sources(workspace(), { tty: true }));
    assert.ok("error" in r && /expected a brief/.test(r.error));
  });
});

describe("lykos run, as a real process", () => {
  const cli = resolve("lykos", "cli.ts");
  // The workspace is a temp folder with no node_modules, so tsx is named by URL.
  const tsx = import.meta.resolve("tsx");
  const run = (args: string[], input?: string, cwd = workspace()) =>
    spawnSync(process.execPath, ["--import", tsx, cli, "run", ...args], {
      cwd,
      input: input ?? "",
      encoding: "utf8",
      env: { ...process.env, LYKOS_TRUST_WORKSPACE: "" },
      timeout: 60_000,
    });

  it("a multi-line task piped on stdin is accepted, and the run goes on to the trust check", () => {
    const r = run([], TASK);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lykos run: refused — workspace is not trusted/);
  });

  it("--shape is retired: both spellings are refused with a pointer to --containment (T185)", () => {
    for (const args of [["--shape", "standalone"], ["--shape=delegate"]]) {
      const r = run(args, TASK);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /lykos run: --shape is retired/);
      assert.match(r.stderr, /--containment off\|auto\|required/);
    }
  });

  it("a missing @file stops the run before anything else, naming the file", () => {
    const r = run(["@missing.md"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lykos run: cannot read @missing\.md/);
  });

  it("`-` with empty stdin stops the run", () => {
    const r = run(["-"], "");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /`-` was given but stdin was empty/);
  });

  it("stdin read through a real pipe arrives byte-identical, non-ASCII included", () => {
    const text = `${TASK}Sunday 23:00 → Monday 01:00 — naïve café\n`;
    const r = spawnSync(
      process.execPath,
      ["--import", tsx, "-e", `import(${JSON.stringify(pathToFileURL(resolve("lykos", "cli", "brief.ts")).href)}).then(m => m.readProcessStdin()).then(t => process.stdout.write(JSON.stringify(t)))`],
      { input: text, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout), text);
  });
});

// T268: an `@path` written inside the prompt attaches the file, the way an `@path` argument does.
describe("resolveRunBrief — @path mentions in the prompt (T268)", () => {
  it("`explain @src/a.ts` sends the file's contents with the prompt, the mention left in place", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const r = await resolveRunBrief({ message: "explain @src/a.ts", files: [], stdin: false }, sources(dir));
    assert.ok("brief" in r, JSON.stringify(r));
    assert.equal(r.brief, `<file name="${resolve(dir, "src", "a.ts")}">\nexport const a = 1;\n\n</file>\nexplain @src/a.ts`);
  });

  it("a missing mention is an error naming it, never a prompt without it", async () => {
    const r = await resolveRunBrief({ message: "upgrade @types/node", files: [], stdin: false }, sources(workspace()));
    assert.ok("error" in r);
    assert.match(r.error, /cannot read @types\/node .*no such file/);
  });

  it("a mention ends before trailing punctuation, and an address is not a mention", async () => {
    const dir = workspace({ "a.md": "A" });
    const r = await resolveRunBrief({ message: "read @a.md, then mail me@example.com.", files: [], stdin: false }, sources(dir));
    assert.ok("brief" in r, JSON.stringify(r));
    assert.deepEqual(r.files, [resolve(dir, "a.md")]);
  });

  it("a file named twice is attached once", async () => {
    const dir = workspace({ "a.md": "A" });
    const r = await resolveRunBrief({ message: "compare @a.md with @a.md", files: ["a.md"], stdin: false }, sources(dir));
    assert.ok("brief" in r, JSON.stringify(r));
    assert.deepEqual(r.files, [resolve(dir, "a.md")]);
  });

  it("after --, the task is verbatim: an `@word` in it attaches nothing", async () => {
    const r = await resolveRunBrief(parseRunBriefArgs(["--", "@mention the owner"]), sources(workspace()));
    assert.deepEqual(r, { brief: "@mention the owner", fromStdin: false, files: [], images: [] });
  });

  it("a workspace-relative `@path`, as lykos-tui's `@` completion inserts it, is the path that attaches", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "deep.ts"), "deep\n");
    const r = await resolveRunBrief({ message: "explain @src/deep.ts", files: [], stdin: false }, sources(dir));
    assert.ok("brief" in r, JSON.stringify(r));
    assert.deepEqual(r.files, [resolve(dir, "src", "deep.ts")]);
  });

  it("a mention outside the workspace follows the workspace rules: with nobody to ask it is refused, naming it", async () => {
    const outside = workspace({ "elsewhere.md": "far" });
    const r = await resolveRunBrief({ message: `read @${join(outside, "elsewhere.md")}`, files: [], stdin: false }, sources(workspace()));
    assert.ok("error" in r, JSON.stringify(r));
    assert.match(r.error, /elsewhere\.md/);
    assert.match(r.error, /outside the allowed folders/);
  });

  it("a mention of a secret path is refused by its rule", async () => {
    const dir = workspace({ ".env": "TOKEN=x" });
    const r = await resolveRunBrief({ message: "check @.env", files: [], stdin: false }, sources(dir));
    assert.ok("error" in r, JSON.stringify(r));
    assert.match(r.error, /\.env/);
    assert.equal(r.error.includes("TOKEN=x"), false);
  });

  it("an @-mentioned PNG becomes an image part, with Pi's empty <file> block naming it in the text", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "shot.png"), png1x1());
    const r = await resolveRunBrief({ message: "what is in @shot.png", files: [], stdin: false }, sources(dir));
    assert.ok("brief" in r, JSON.stringify(r));
    assert.equal(r.brief, `<file name="${resolve(dir, "shot.png")}"></file>\nwhat is in @shot.png`);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.path, resolve(dir, "shot.png"));
    assert.equal(r.images[0]!.mimeType, "image/png");
    assert.deepEqual(Buffer.from(r.images[0]!.data, "base64").subarray(0, 8), PNG_SIGNATURE);
  });
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A real one-pixel RGBA PNG, built from its chunks. */
function png1x1(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
