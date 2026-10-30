// T34.2 — unit tests against the Operations objects directly: the gating
// logic this module actually adds (scope clamp, approve/deny/always-allow),
// exercised without faking Pi's `ExtensionContext`/tool-dispatch machinery,
// which is Pi's own responsibility and was proven working end to end with a
// real AgentSession and a real DeepSeek call before this module was written
// (a `customTools` entry sharing a built-in tool's name shadows the
// built-in cleanly — see DECISIONS.md 2026-08-31 "T34").

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AutoApproveGate,
  DenyAllGate,
  DenialLog,
  ReadOnlyGate,
  TerminalApprovalGate,
  isWithinRoot,
  buildWriteOperations,
  buildEditOperations,
  buildBashOperations,
  buildPowerShellOperations,
  ApprovalDeniedError,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type GatedToolKind,
} from "./approval.js";
// T88's marker exit code, imported from the module that owns it rather than
// re-exported through the gate: the timeout is `bash-timeout.ts`'s decision
// and the gate is one of its callers, not its owner.
import { TIMEOUT_EXIT_CODE } from "../loop/bash-timeout.js";

class ScriptedGate implements ApprovalGate {
  seen: ApprovalRequest[] = [];
  constructor(private readonly decision: ApprovalDecision) {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.decision;
  }
}

async function rejects(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, ApprovalDeniedError);
}

describe("isWithinRoot (T30.2 scope clamp)", () => {
  it("accepts the root itself and anything nested under it", () => {
    assert.equal(isWithinRoot("/proj", "/proj"), true);
    assert.equal(isWithinRoot("/proj", "/proj/sub/file.txt"), true);
  });
  it("refuses a path outside the root, including a sibling that shares a prefix", () => {
    assert.equal(isWithinRoot("/proj", "/proj-other/file.txt"), false);
    assert.equal(isWithinRoot("/proj", "/etc/passwd"), false);
    assert.equal(isWithinRoot("/proj", "/"), false);
  });
  it("accepts a directory inside the root whose name starts with two dots (D17)", () => {
    assert.equal(isWithinRoot("/proj", "/proj/..cache/file.txt"), true);
    assert.equal(isWithinRoot("/proj", "/proj/..."), true);
    assert.equal(isWithinRoot("/proj", "/proj/../other"), false);
  });
});

describe("buildWriteOperations (T34.2)", () => {
  it("allow: the real file is written, and the gate saw the request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-write-"));
    try {
      const gate = new ScriptedGate("allow");
      const ops = buildWriteOperations(dir, gate);
      const target = join(dir, "hello.txt");
      await ops.writeFile(target, "hi");
      assert.equal(readFileSync(target, "utf8"), "hi");
      assert.equal(gate.seen.length, 1);
      assert.equal(gate.seen[0]!.kind, "write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deny: the file never touches the working tree, and the rejection is a typed error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-write-deny-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildWriteOperations(dir, gate);
      const target = join(dir, "hello.txt");
      await rejects(ops.writeFile(target, "hi"));
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // **This assertion was reversed by T131's follow-up, deliberately.** It
  // used to read "the gate is asked once, then every later write in this
  // session skips it", and asserted `alwaysAllowed.has("write")`. That
  // kind-wide grant sat in FRONT of the gate, and once the interaction mode
  // moved inside the gate it meant an `allow-always` took the mode out of
  // the decision permanently — a later Ask or Plan mode could not refuse a
  // write, and a later `rm -rf` never reached the destructive check. The
  // grant is now a per-project command PATTERN remembered inside the gate,
  // so the gate is still consulted every time and can apply it itself.
  it("allow-always: the gate is still asked, because it is what remembers and what enforces the mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-write-always-"));
    try {
      const gate = new ScriptedGate("allow-always");
      const ops = buildWriteOperations(dir, gate);
      await ops.writeFile(join(dir, "a.txt"), "1");
      await ops.writeFile(join(dir, "b.txt"), "2");
      assert.equal(gate.seen.length, 2, "every write reaches the gate; nothing short-circuits in front of it");
      // Both still land: `allow-always` permits the request that answered it.
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1");
      assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope: a path outside the project root ASKS, and a refusal there writes nothing (T210)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-write-scope-"));
    const outside = mkdtempSync(join(tmpdir(), "lykos-t34-outside-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildWriteOperations(dir, gate);
      const target = join(outside, "escape.txt");
      await rejects(ops.writeFile(target, "hi"));
      assert.equal(existsSync(target), false);
      assert.equal(gate.seen.length, 1, "outside the root is a question now, not a refusal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("scope clamp: a deny rule on a path outside the root refuses WITHOUT ever asking the gate (T210)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t210-write-scope-"));
    const outside = mkdtempSync(join(tmpdir(), "lykos-t210-outside-"));
    try {
      mkdirSync(join(dir, ".lykos"), { recursive: true });
      writeFileSync(join(dir, ".lykos", "config.yaml"), `path_rules:
  write:
    '${outside.split("\\").join("/")}/**': deny
`);
      const gate = new ScriptedGate("allow");
      const ops = buildWriteOperations(dir, gate);
      const target = join(outside, "escape.txt");
      await rejects(ops.writeFile(target, "hi"));
      assert.equal(existsSync(target), false);
      assert.equal(gate.seen.length, 0, "a deny is never a question");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("mkdir does not prompt (precondition for the meaningful write, not itself gated) but still respects scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-mkdir-"));
    const outside = mkdtempSync(join(tmpdir(), "lykos-t34-mkdir-outside-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildWriteOperations(dir, gate);
      await ops.mkdir(join(dir, "sub", "dir"));
      assert.equal(existsSync(join(dir, "sub", "dir")), true);
      assert.equal(gate.seen.length, 0);
      await rejects(ops.mkdir(join(outside, "escape")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("buildEditOperations (T34.2)", () => {
  it("deny: the file's content is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-edit-"));
    try {
      const target = join(dir, "existing.txt");
      writeFileSync(target, "before", "utf8");
      const gate = new ScriptedGate("deny");
      const ops = buildEditOperations(dir, gate);
      await rejects(ops.writeFile(target, "after"));
      assert.equal(readFileSync(target, "utf8"), "before");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allow: the file's content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-edit-allow-"));
    try {
      const target = join(dir, "existing.txt");
      writeFileSync(target, "before", "utf8");
      const gate = new ScriptedGate("allow");
      const ops = buildEditOperations(dir, gate);
      await ops.writeFile(target, "after");
      assert.equal(readFileSync(target, "utf8"), "after");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildBashOperations (T34.2)", () => {
  it("deny: the command never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-bash-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildBashOperations(dir, gate);
      const marker = join(dir, "ran.txt");
      const cmd = process.platform === "win32" ? `echo hi > "${marker}"` : `touch "${marker}"`;
      await rejects(ops.exec(cmd, dir, { onData: () => {} }));
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allow: the command actually runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t34-bash-allow-"));
    try {
      const gate = new ScriptedGate("allow");
      const ops = buildBashOperations(dir, gate);
      const marker = join(dir, "ran.txt");
      const cmd = process.platform === "win32" ? `echo hi > "${marker}"` : `touch "${marker}"`;
      const { exitCode } = await ops.exec(cmd, dir, { onData: () => {} });
      assert.equal(exitCode, 0);
      assert.equal(existsSync(marker), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// P10.4 (ticket 13, D3). Two questions, and only the first of them is about
// running a command.
describe("buildPowerShellOperations (P10.4 D3)", () => {
  it("deny: the command never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-p104-ps-deny-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildPowerShellOperations(dir, gate);
      const marker = join(dir, "ran.txt");
      await rejects(ops.exec(`New-Item -ItemType File "${marker}"`, dir, { onData: () => {} }));
      assert.equal(existsSync(marker), false);
      assert.equal(gate.seen.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches the gate exactly as bash does, and says which shell it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-p104-ps-req-"));
    try {
      const gate = new ScriptedGate("deny");
      await rejects(
        buildPowerShellOperations(dir, gate).exec("Get-ChildItem", dir, { onData: () => {} }),
      );
      const ps = gate.seen[0]!;
      assert.equal(ps.kind, "bash");
      assert.equal(ps.summary, "run command");
      assert.equal(ps.detail, "Get-ChildItem");
      assert.equal(ps.shell, "powershell");

      // `bash` is the same request in every field but that last one, which is
      // the whole point: same modal, same session scope, same denial record —
      // a different answer only where the tier is decided.
      const bashGate = new ScriptedGate("deny");
      await rejects(buildBashOperations(dir, bashGate).exec("ls", dir, { onData: () => {} }));
      const bash = bashGate.seen[0]!;
      assert.equal(bash.kind, ps.kind);
      assert.equal(bash.summary, ps.summary);
      assert.equal(bash.shell, "bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a refusal the same way bash does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-p104-ps-denials-"));
    try {
      const denials = new DenialLog();
      await rejects(
        buildPowerShellOperations(dir, new ScriptedGate("deny"), denials).exec("Get-Date", dir, {
          onData: () => {},
        }),
      );
      assert.equal(denials.userRejected, 1);
      assert.equal(denials.last, "bash Get-Date (user_rejected)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Runs a real `Start-Sleep`, which needs the PowerShell tool — Windows only.
  it("applies T88's default timeout when the model named none", { skip: process.platform !== "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-p104-ps-timeout-"));
    try {
      // The timeout has to be observable without waiting for one, so the
      // fallback is turned down to a value the command cannot survive. A
      // timeout the model chose is still honoured — that half is `bash`'s
      // and is shared code, not a second implementation.
      const ops = buildPowerShellOperations(dir, new AutoApproveGate(), undefined, {
        defaultTimeoutSeconds: 1,
      });
      let output = "";
      const { exitCode } = await ops.exec("Start-Sleep -Seconds 30", dir, {
        onData: (d: Buffer) => {
          output += d.toString("utf8");
        },
      });
      assert.equal(exitCode, TIMEOUT_EXIT_CODE);
      assert.match(output, /\[lykos-timeout\] Killed after 1s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AutoApproveGate / DenyAllGate", () => {
  it("AutoApproveGate always allows without a scripted answer", async () => {
    const gate = new AutoApproveGate();
    assert.equal(await gate.request({ kind: "write", summary: "x", detail: "/tmp/x" }), "allow");
  });
  it("DenyAllGate always denies — the safe default with no TTY to prompt on", async () => {
    const gate = new DenyAllGate();
    assert.equal(await gate.request({ kind: "bash", summary: "x", detail: "echo hi" }), "deny");
  });
});

describe("P4 T149 ReadOnlyGate", () => {
  it("allows a read and refuses every other kind", async () => {
    const gate = new ReadOnlyGate();
    assert.equal(await gate.request({ kind: "read", summary: "x", detail: "a.ts" }), "allow");
    const kinds: GatedToolKind[] = ["write", "edit", "bash", "github", "eval", "extension"];
    for (const kind of kinds) {
      assert.equal(await gate.request({ kind, summary: "x", detail: "a.ts" }), "deny", kind);
    }
  });

  it("a write refused by it never reaches the filesystem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-ro-gate-"));
    try {
      const ops = buildWriteOperations(dir, new ReadOnlyGate());
      await assert.rejects(() => ops.writeFile(join(dir, "a.txt"), "x"), ApprovalDeniedError);
      assert.equal(existsSync(join(dir, "a.txt")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DenialLog (D7 specialist restrictions)", () => {
  it("records specialist_restricted denials and counts them in total", () => {
    const denials = new DenialLog();
    denials.record("specialist_restricted", "bash", "reviewer");
    assert.equal(denials.specialistRestricted, 1);
    assert.equal(denials.total, 1);
    assert.equal(denials.last, "bash reviewer (specialist_restricted)");
  });
});

describe("T212: bash and powershell path gating through authorize", () => {
  it("a bash call of cat .env through authorize is denied with the same rule a read gets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t212-bash-"));
    try {
      const gate = new ScriptedGate("allow");
      const ops = buildBashOperations(dir, gate);
      let bashErr: ApprovalDeniedError | undefined;
      try {
        await ops.exec("cat .env", dir, { onData: () => {} });
      } catch (e) {
        if (e instanceof ApprovalDeniedError) bashErr = e;
      }
      assert.ok(bashErr, "cat .env should be denied by path rules");
      assert.match(bashErr.message, /refused — cat \.env: denied: secret path `\*\.env`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("echo x > .git/config reaches the gate as a protected ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t212-gitconfig-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildBashOperations(dir, gate);
      await rejects(ops.exec("echo x > .git/config", dir, { onData: () => {} }));
      assert.equal(gate.seen.length, 1);
      const req = gate.seen[0]!;
      assert.equal(req.kind, "bash");
      assert.equal(req.detail, "echo x > .git/config");
      assert.deepEqual(req.pathAsk, { rule: ".git/**", protected: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("powershell gc .env is denied and Out-File .git/config reaches gate as protected ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t212-ps-"));
    try {
      const gate = new ScriptedGate("deny");
      const ops = buildPowerShellOperations(dir, gate);
      let psErr: ApprovalDeniedError | undefined;
      try {
        await ops.exec("gc .env", dir, { onData: () => {} });
      } catch (e) {
        if (e instanceof ApprovalDeniedError) psErr = e;
      }
      assert.ok(psErr, "gc .env should be denied by path rules");
      assert.match(psErr.message, /refused — gc \.env: denied: secret path `\*\.env`/);

      await rejects(ops.exec("Out-File .git/config", dir, { onData: () => {} }));
      assert.equal(gate.seen.length, 1);
      const req = gate.seen[0]!;
      assert.deepEqual(req.pathAsk, { rule: ".git/**", protected: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TerminalApprovalGate bash path ask prompt offers allow once and deny only", async () => {
    const inputLines = ["a\n", "f\n", "y\n"];
    let idx = 0;
    let output = "";
    const gate = new TerminalApprovalGate(
      async () => inputLines[idx++] ?? null,
      { write: (c) => { output += c; } },
    );
    const r1 = await gate.request({
      kind: "bash",
      summary: "run command",
      detail: "cat /etc/hosts",
      pathAsk: { rule: "outside the project directory" },
    });
    assert.equal(r1, "deny");
    assert.match(output, /\[y\] allow once\s+\[n\] deny \(default\)/);
    assert.doesNotMatch(output, /always allow/);
    assert.doesNotMatch(output, /allow this folder/);

    const r2 = await gate.request({
      kind: "bash",
      summary: "run command",
      detail: "cat /etc/hosts",
      pathAsk: { rule: "outside the project directory" },
    });
    assert.equal(r2, "deny");

    const r3 = await gate.request({
      kind: "bash",
      summary: "run command",
      detail: "cat /etc/hosts",
      pathAsk: { rule: "outside the project directory" },
    });
    assert.equal(r3, "allow");
  });
});
