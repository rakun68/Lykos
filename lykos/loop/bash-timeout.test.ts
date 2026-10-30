import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  bashTimeoutFromEnv,
  isTimeoutError,
  resolveBashTimeout,
  timeoutNotice,
  TIMEOUT_EXIT_CODE,
} from "./bash-timeout.js";
import { AutoApproveGate, DenialLog, buildBashOperations } from "../gate/approval.js";

describe("bashTimeoutFromEnv", () => {
  it("supplies a default when nothing is configured", () => {
    assert.equal(bashTimeoutFromEnv({} as NodeJS.ProcessEnv), DEFAULT_BASH_TIMEOUT_SECONDS);
  });

  it("lets an operator restore Pi's unbounded behaviour explicitly", () => {
    assert.equal(bashTimeoutFromEnv({ LYKOS_BASH_TIMEOUT: "0" } as NodeJS.ProcessEnv), undefined);
  });

  it("takes a configured value", () => {
    assert.equal(bashTimeoutFromEnv({ LYKOS_BASH_TIMEOUT: "45" } as NodeJS.ProcessEnv), 45);
  });
});

describe("resolveBashTimeout", () => {
  it("always honours a timeout the model asked for", () => {
    assert.equal(resolveBashTimeout(900, 300), 900, "the model may know its build is slow");
  });

  it("applies the fallback only when nothing was asked for", () => {
    assert.equal(resolveBashTimeout(undefined, 300), 300);
  });

  it("ignores a nonsense request rather than passing it down", () => {
    assert.equal(resolveBashTimeout(0, 300), 300);
    assert.equal(resolveBashTimeout(Number.NaN, 300), 300);
    assert.equal(resolveBashTimeout(-5, 300), 300);
  });

  it("stays unbounded when the fallback is off and nothing was asked for", () => {
    assert.equal(resolveBashTimeout(undefined, undefined), undefined);
  });
});

describe("isTimeoutError", () => {
  it("recognises Pi's own timeout throw and nothing else", () => {
    assert.equal(isTimeoutError(new Error("timeout:300")), true);
    assert.equal(isTimeoutError(new Error("aborted")), false);
    assert.equal(isTimeoutError(new Error("command not found: the timeout: thing")), false);
  });
});

describe("timeoutNotice", () => {
  it("says the output above is what it managed to print", () => {
    const note = timeoutNotice("npm run dev", 300, true);
    assert.ok(note.includes("Killed after 300s"));
    assert.ok(note.includes("npm run dev"));
    assert.ok(note.includes("everything it printed"));
    assert.ok(note.includes("Do not simply re-run it"));
  });

  it("distinguishes silence, which usually means it wanted input", () => {
    const note = timeoutNotice("npm install", 300, false);
    assert.ok(note.includes("printed nothing at all"));
    assert.ok(note.includes("waiting for input"));
  });

  it("names concrete remedies rather than just reporting the failure", () => {
    const note = timeoutNotice("x", 10, true);
    assert.ok(note.includes("background"));
    assert.ok(note.includes("non-interactive flag"));
    assert.ok(note.includes("larger timeout"));
  });
});

describe("T88 end to end through the gated bash tool", () => {
  it("kills a command that never exits and returns what it printed", async () => {
    const denials = new DenialLog();
    const cwd = process.cwd();
    const ops = buildBashOperations(cwd, new AutoApproveGate(), denials, {
      defaultTimeoutSeconds: 1,
    });
    const chunks: string[] = [];
    const started = Date.now();
    const result = await ops.exec(
      // No redirection: on Windows a `> nul` under this shell creates a real
      // file called `nul` in the repo, which git then refuses to index.
      process.platform === "win32"
        ? "echo before-hang && ping -n 30 127.0.0.1"
        : "echo before-hang && sleep 30",
      cwd,
      { onData: (d) => chunks.push(d.toString("utf8")) },
    );
    const elapsed = Date.now() - started;
    const output = chunks.join("");
    assert.equal(result.exitCode, TIMEOUT_EXIT_CODE, "a timeout is a non-zero exit, not a throw");
    assert.ok(elapsed < 20_000, `it must actually return early; took ${elapsed}ms`);
    assert.ok(output.includes("before-hang"), "partial output is preserved -- that is the point");
    assert.ok(output.includes("[lykos-timeout]"), "and the model is told why it stopped");
  });

  it("leaves a fast command completely alone", async () => {
    const cwd = process.cwd();
    const ops = buildBashOperations(cwd, new AutoApproveGate(), new DenialLog(), {
      defaultTimeoutSeconds: 60,
    });
    const chunks: string[] = [];
    const result = await ops.exec("echo quick", cwd, { onData: (d) => chunks.push(d.toString("utf8")) });
    assert.equal(result.exitCode, 0);
    assert.ok(chunks.join("").includes("quick"));
    assert.ok(!chunks.join("").includes("[lykos-timeout]"));
  });
});
