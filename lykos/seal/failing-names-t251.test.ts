// T251: failing test names from cargo, and the exit-plus-hash fallback for any other runner.
// The cargo fixture is the real output of `cargo test --no-fail-fast` (cargo 1.97.1) on a crate with a
// failing unit test, a non-assertion panic, an ignored test and a failing integration test.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localExecutor } from "../tools/executor.js";
import { failureSignature, isCargoTestCommand, normaliseFailingOutput, parseCargoTestOutput } from "./failing-names.js";
import { detectAdapter, runRedCheck, runSealedTests } from "./runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const cargoOutput = readFileSync(join(here, "fixtures", "cargo-test-output.txt"), "utf8");

describe("T251: cargo's failing test names", () => {
  it("is chosen for cargo test commands only", () => {
    assert.equal(detectAdapter("cargo test"), "cargo");
    assert.equal(detectAdapter("cargo +nightly test --no-fail-fast"), "cargo");
    assert.equal(detectAdapter("cargo --locked test -p core"), "cargo");
    assert.equal(detectAdapter("cargo build"), "exit");
    assert.equal(isCargoTestCommand("npm test"), false);
  });

  it("parses every test from real cargo output, attributed to its target", () => {
    const tests = parseCargoTestOutput(cargoOutput);
    const byPath = new Map(tests.map((t) => [`${t.file}::${[...t.describe, t.name].join("::")}`, t]));
    assert.equal(tests.length, 6);
    assert.equal(byPath.get("src/lib.rs::tests::adds_two")?.status, "assertion");
    assert.equal(byPath.get("src/lib.rs::tests::subtracts_zero")?.status, "pass");
    assert.equal(byPath.get("src/lib.rs::tests::nested::skipped")?.status, "skip");
    assert.equal(byPath.get("tests/api.rs::api_adds")?.status, "assertion");
    assert.equal(byPath.get("tests/api.rs::api_ok")?.status, "pass");
    assert.deepEqual(byPath.get("src/lib.rs::tests::adds_two")?.describe, ["tests"]);
  });

  it("a panic that is not an assertion is an error, with its message", () => {
    const t = parseCargoTestOutput(cargoOutput).find((x) => x.name === "deep_failure");
    assert.equal(t?.status, "error");
    assert.equal(t?.errorDetail, "boom");
  });

  it("an assertion failure carries its message", () => {
    const t = parseCargoTestOutput(cargoOutput).find((x) => x.name === "api_adds");
    assert.match(t?.errorDetail ?? "", /^assertion `left == right` failed/);
  });
});

describe("T251: the fallback is exit plus a normalised output hash", () => {
  const runA = "\x1b[31mFAIL\x1b[0m test_parse (2.31s)\r\n  at C:\\work\\tmp-a\\src\\x.py:12\r\nthread 'main' (4411) panicked\r\nrun 2026-11-06T10:00:01Z id 9f3a2b7c1d\r\n";
  const runB = "thread 'main' (88) panicked\n\x1b[31mFAIL\x1b[0m test_parse (0.04s)\n  at /home/ci/tmp-b/src/x.py:12\nrun 2026-11-07T22:13:59Z id 0ab45cd9ee\n";

  it("two runs of one failure hash the same", () => {
    const a = failureSignature(1, runA, ["C:\\work\\tmp-a"]);
    const b = failureSignature(1, runB, ["/home/ci/tmp-b"]);
    assert.equal(a.hash, b.hash, `${normaliseFailingOutput(runA, ["C:\\work\\tmp-a"])}\n---\n${normaliseFailingOutput(runB, ["/home/ci/tmp-b"])}`);
    assert.equal(a.exit, 1);
  });

  it("a different failure hashes differently", () => {
    assert.notEqual(failureSignature(1, runA).hash, failureSignature(1, runA.replace("test_parse", "test_emit")).hash);
  });

  it("exit-code mode returns the signature, and it is the same on a second run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t251-"));
    const script = join(dir, "check.js");
    writeFileSync(script, `console.log("FAIL case_one in " + (Date.now() % 1000) + "ms at " + process.cwd()); process.exit(3);\n`);
    const template = `"${process.execPath}" check.js {files}`;
    assert.equal(detectAdapter(template), "exit");
    const first = await runRedCheck({ worktreeDir: dir, testFiles: ["check.js"], testCommandTemplate: template });
    const second = await runSealedTests({ executor: localExecutor, dir, files: ["check.js"], template, mode: "red" });
    assert.equal(first.ok, true);
    assert.equal(first.signature?.exit, 3);
    assert.equal(first.signature?.hash, second.signature?.hash);
  });
});

describe("T251: cargo mode end to end", () => {
  let cargo = true;
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    cargo = false;
  }

  it("the red check reports the failing assertions of a real crate", { skip: cargo ? false : "cargo is not installed" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t251-crate-"));
    mkdirSync(join(dir, "tests"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(dir, "src", "lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { a - b }\n");
    writeFileSync(join(dir, "tests", "api.rs"), "#[test]\nfn api_adds() { assert_eq!(fx::add(1, 1), 2); }\n");
    const res = await runRedCheck({ worktreeDir: dir, testFiles: ["tests/api.rs"], testCommandTemplate: "cargo test --no-fail-fast --test api" });
    assert.equal(res.adapter, "cargo");
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.red, [{ file: "tests/api.rs", describe: [], name: "api_adds", failure: "assertion" }]);
  });
});
