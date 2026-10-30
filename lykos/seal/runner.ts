import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import type { SealAdapter, SealRedTest } from "./types.js";

const REPORTER_CJS = `
module.exports = async function* reporter(source) {
  for await (const event of source) {
    yield JSON.stringify(event) + "\\n";
  }
};
`;

export interface SealedTestResult {
  file: string;
  describe: string[];
  name: string;
  status: "pass" | "assertion" | "error" | "skip";
  errorDetail?: string | undefined;
}

export interface RunSealedTestsOptions {
  executor: ProjectExecutor;
  dir: string;
  files: readonly string[];
  template: string;
  mode: "red" | "green";
  env?: NodeJS.ProcessEnv | undefined;
}

export interface RunSealedTestsResult {
  ok: boolean;
  adapter: SealAdapter;
  tests: SealedTestResult[];
  errors: string[];
  warnings?: string[] | undefined;
  fileErrors: Map<string, string>;
  rawOutput?: string | undefined;
}

export interface RunRedCheckOptions {
  worktreeDir: string;
  testFiles: readonly string[];
  testCommandTemplate: string;
  env?: NodeJS.ProcessEnv | undefined;
  executor?: ProjectExecutor | undefined;
}

export interface RunRedCheckResult {
  ok: boolean;
  adapter: SealAdapter;
  red: SealRedTest[];
  errors: string[];
  warnings?: string[] | undefined;
}

export function detectAdapter(template: string): SealAdapter {
  if (/\bvitest\b/i.test(template) || template.includes("vitest")) {
    return "vitest";
  }
  if (/\b(node|tsx)\b.*--test\b/.test(template)) {
    return "node:test";
  }
  return "exit";
}

export function isAssertionFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["code"] === "ERR_ASSERTION" || e["name"] === "AssertionError") return true;
  if (e["cause"]) return isAssertionFailure(e["cause"]);
  return false;
}

export function isVitestAssertionFailure(failureMessages?: readonly string[] | undefined): boolean {
  if (!failureMessages || failureMessages.length === 0) return false;
  return failureMessages.some((msg) => {
    const firstLine = msg.split("\n")[0]?.trim() ?? "";
    return /^AssertionError\b|\bERR_ASSERTION\b/.test(firstLine);
  });
}

function normalizeTestPath(rawFile: string, workdir: string, realDir: string): string {
  if (!rawFile) return "";
  let normRaw = rawFile;
  try {
    normRaw = realpathSync(rawFile);
  } catch {}
  let rel = relative(realDir, normRaw).replace(/\\/g, "/");
  if (rel.startsWith("..") || rel.includes(":")) {
    rel = relative(workdir, rawFile).replace(/\\/g, "/");
  }
  if (rel.startsWith("..") || rel.includes(":")) {
    return rawFile.replace(/\\/g, "/");
  }
  return rel;
}

function mapReportedPath(rawFile: string, files: readonly string[], workdir: string, realDir: string): string {
  if (!rawFile) return "";
  const norm = rawFile.replace(/\\/g, "/");
  for (const f of files) {
    const strippedF = f.replace(/\\/g, "/").replace(/^\.\//, "");
    if (norm.endsWith("/" + strippedF) || norm === strippedF) {
      return f;
    }
  }
  return normalizeTestPath(rawFile, workdir, realDir);
}

function validateResults(
  opts: RunSealedTestsOptions,
  adapter: SealAdapter,
  testsByFile: Map<string, SealedTestResult[]>,
  fileErrors: Map<string, string>,
  fileStderr: Map<string, string[]>,
  rawOutput: string,
): RunSealedTestsResult {
  const errors: string[] = [];
  const collectedTests: SealedTestResult[] = [];
  const seenIdentities = new Set<string>();

  for (const testFile of opts.files) {
    const normFile = testFile.replace(/\\/g, "/");

    if (fileErrors.has(normFile)) {
      const stderrText = (fileStderr.get(normFile) ?? []).join("");
      errors.push(`${normFile}: error: ${fileErrors.get(normFile)}${stderrText ? `\n${stderrText}` : ""}`);
      continue;
    }

    const tests = testsByFile.get(normFile) ?? [];
    if (tests.length === 0) {
      errors.push(`${normFile}: not collected (0 tests collected)`);
      continue;
    }

    const executedTests = tests.filter((t) => t.status !== "skip");
    if (executedTests.length === 0) {
      errors.push(`${normFile}: not collected (all tests skipped)`);
      continue;
    }

    for (const t of tests) {
      collectedTests.push(t);
      const id = `${normFile}::${t.describe.join(" > ")}::${t.name}`;
      if (seenIdentities.has(id)) {
        errors.push(`${normFile}: duplicate test "${t.name}" in describe "${t.describe.join(" > ") || "root"}"`);
      }
      seenIdentities.add(id);

      if (opts.mode === "red") {
        if (t.status === "pass") {
          errors.push(`${normFile}: "${t.name}" passed (sealed tests must fail)`);
        } else if (t.status === "error") {
          errors.push(`${normFile}: "${t.name}" error: ${t.errorDetail ?? "test code error"}`);
        } else if (t.status === "skip") {
          errors.push(`${normFile}: "${t.name}" skipped (sealed tests must not be skipped)`);
        }
      } else if (opts.mode === "green") {
        if (t.status !== "pass") {
          errors.push(`${normFile}: "${t.name}" failed: ${t.status} ${t.errorDetail ?? ""}`.trim());
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    adapter,
    tests: collectedTests,
    errors,
    fileErrors,
    rawOutput,
  };
}

async function runExitMode(
  opts: RunSealedTestsOptions,
  testEnv: NodeJS.ProcessEnv,
): Promise<RunSealedTestsResult> {
  const quotedFiles = opts.files.map((f) => `"${f}"`).join(" ");
  const cmd = opts.template.replace("{files}", quotedFiles);

  let stdout = "";
  let stderr = "";

  const child = opts.executor.spawn(cmd, [], {
    cwd: opts.dir,
    shell: true,
    env: testEnv,
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  if (opts.mode === "red") {
    if (exitCode === 0) {
      return {
        ok: false,
        adapter: "exit",
        tests: [],
        errors: ["the test command passed (sealed tests must fail)"],
        fileErrors: new Map(),
        rawOutput: `${stdout}\n${stderr}`,
      };
    }
    return {
      ok: true,
      adapter: "exit",
      tests: [],
      errors: [],
      warnings: ["warning: sealing in exit-code mode; this is a weaker guarantee with no per-test evidence"],
      fileErrors: new Map(),
      rawOutput: `${stdout}\n${stderr}`,
    };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      adapter: "exit",
      tests: [],
      errors: [`test command failed with exit code ${exitCode}:\n${stderr || stdout}`],
      fileErrors: new Map(),
      rawOutput: `${stdout}\n${stderr}`,
    };
  }
  return {
    ok: true,
    adapter: "exit",
    tests: [],
    errors: [],
    fileErrors: new Map(),
    rawOutput: `${stdout}\n${stderr}`,
  };
}

async function runVitestMode(
  opts: RunSealedTestsOptions,
  testEnv: NodeJS.ProcessEnv,
): Promise<RunSealedTestsResult> {
  const hasJsonReporter = /(?:^|\s)--reporter(?:=|\s+)json(?:\s|$)/.test(opts.template);
  const quotedFiles = opts.files.map((f) => `"${f}"`).join(" ");
  const reporterArg = hasJsonReporter ? "" : "--reporter=json ";
  const injected = `${reporterArg}${quotedFiles}`;
  const cmd = opts.template.replace("{files}", injected);

  let stdout = "";
  let stderr = "";

  try {
    const child = opts.executor.spawn(cmd, [], {
      cwd: opts.dir,
      shell: true,
      env: testEnv,
      containerPaths: true,
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });

    let vitestData: any;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && (Array.isArray(parsed.testResults) || typeof parsed.numTotalTestSuites === "number")) {
          vitestData = parsed;
          break;
        }
      } catch {}
    }

    if (!vitestData) {
      const defaultOut = join(opts.dir, ".vitest", "json", "output.json");
      if (existsSync(defaultOut)) {
        try {
          vitestData = JSON.parse(readFileSync(defaultOut, "utf8"));
        } catch (e) {
          return {
            ok: false,
            adapter: "vitest",
            tests: [],
            errors: [`failed to parse vitest JSON output: ${e instanceof Error ? e.message : String(e)}`],
            fileErrors: new Map(),
            rawOutput: `${stdout}\n${stderr}`,
          };
        }
      }
    }

    if (!vitestData) {
      return {
        ok: false,
        adapter: "vitest",
        tests: [],
        errors: [`test command failed to produce reporter output:\n${stderr || stdout}`],
        fileErrors: new Map(),
        rawOutput: `${stdout}\n${stderr}`,
      };
    }

    let realDir = opts.dir;
    try {
      realDir = realpathSync(opts.dir);
    } catch {}

    const testsByFile = new Map<string, SealedTestResult[]>();
    const fileErrors = new Map<string, string>();

    const suiteResults = Array.isArray(vitestData.testResults) ? vitestData.testResults : [];

    for (const suite of suiteResults) {
      const rawFile = suite.name;
      const file = mapReportedPath(rawFile, opts.files, opts.dir, realDir);
      if (!file) continue;

      const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];

      if (assertions.length === 0) {
        if (suite.status === "failed" && suite.message && !/no test found/i.test(suite.message)) {
          fileErrors.set(file, suite.message.trim());
        } else {
          testsByFile.set(file, []);
        }
        continue;
      }

      const fileTests: SealedTestResult[] = [];
      for (const a of assertions) {
        const describe = Array.isArray(a.ancestorTitles) ? a.ancestorTitles : [];
        const name = a.title || a.fullName || "";
        let status: "pass" | "assertion" | "error" | "skip";
        let errorDetail: string | undefined;

        if (a.status === "passed") {
          status = "pass";
        } else if (a.status === "skipped" || a.status === "pending" || a.status === "todo") {
          status = "skip";
        } else if (a.status === "failed") {
          const isAssert = isVitestAssertionFailure(a.failureMessages);
          if (isAssert) {
            status = "assertion";
          } else {
            status = "error";
            errorDetail = (a.failureMessages?.[0]?.split("\n")[0] || "test execution error").trim();
          }
        } else {
          status = "skip";
        }

        fileTests.push({
          file,
          describe,
          name,
          status,
          ...(errorDetail !== undefined ? { errorDetail } : {}),
        });
      }

      testsByFile.set(file, fileTests);

      if (suite.status === "failed" && suite.message && suite.message.trim().length > 0 && !/no test found/i.test(suite.message)) {
        fileErrors.set(file, suite.message.trim());
      }
    }

    return validateResults(opts, "vitest", testsByFile, fileErrors, new Map(), `${stdout}\n${stderr}`);
  } finally {
    try {
      const defaultOut = join(opts.dir, ".vitest");
      if (existsSync(defaultOut)) rmSync(defaultOut, { recursive: true, force: true });
    } catch {}
  }
}

async function runNodeTestMode(
  opts: RunSealedTestsOptions,
  testEnv: NodeJS.ProcessEnv,
): Promise<RunSealedTestsResult> {
  const reporterRel = `.lykos-seal-reporter-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`;
  const reporterPath = join(opts.dir, reporterRel);

  writeFileSync(reporterPath, REPORTER_CJS, "utf8");

  try {
    const quotedFiles = opts.files.map((f) => `"${f}"`).join(" ");
    const injected = `--test-reporter="./${reporterRel}" --test-reporter-destination=stdout ${quotedFiles}`;
    const cmd = opts.template.replace("{files}", injected);

    let stdout = "";
    let stderr = "";

    const child = opts.executor.spawn(cmd, [], {
      cwd: opts.dir,
      shell: true,
      env: testEnv,
      containerPaths: true,
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });

    const lines = stdout.split("\n");
    const suiteParents = new Map<string, { name: string; parentId: number }>();
    const testsByFile = new Map<string, SealedTestResult[]>();
    const fileErrors = new Map<string, string>();
    const fileStderr = new Map<string, string[]>();
    const startStacks = new Map<string, string[]>();

    let realDir = opts.dir;
    try {
      realDir = realpathSync(opts.dir);
    } catch {}

    let parsedAnyEvent = false;

    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const data = event?.data;
      if (!data) continue;
      parsedAnyEvent = true;

      const rawFile = data.file || data.entryFile;
      const file = mapReportedPath(rawFile, opts.files, opts.dir, realDir);

      if (event.type === "test:stderr") {
        if (file) {
          const arr = fileStderr.get(file) ?? [];
          arr.push(data.message || "");
          fileStderr.set(file, arr);
        }
        continue;
      }

      if (event.type === "test:enqueue" || event.type === "test:start") {
        if (data.type === "suite") {
          suiteParents.set(`${file}:${data.testId}`, { name: data.name, parentId: data.parentId });
        }
      }

      // Node versions without testId/parentId: test:start events arrive in order per file,
      // so the names at lower nesting levels are the ancestors.
      if (event.type === "test:start" && typeof data.nesting === "number") {
        const stack = startStacks.get(file) ?? [];
        stack.length = data.nesting;
        stack.push(data.name);
        startStacks.set(file, stack);
      }

      if (event.type === "test:fail") {
        if (data.details?.type === "suite") {
          continue;
        }

        const isFileLevel =
          data.name === data.file ||
          ((data.parentId === 0 || (data.parentId === undefined && data.nesting === 0)) &&
            rawFile &&
            data.name &&
            String(rawFile).replace(/\\/g, "/").endsWith(`/${data.name}`));

        if (isFileLevel) {
          const stderrText = (fileStderr.get(file) ?? []).join("");
          const errDetail =
            data.details?.error?.message ||
            stderrText.trim().split("\n").pop() ||
            data.details?.error?.code ||
            "test execution error";
          fileErrors.set(file, errDetail);
          continue;
        }

        const describe: string[] = [];
        let curr = data.parentId;
        while (curr && suiteParents.has(`${file}:${curr}`)) {
          const s = suiteParents.get(`${file}:${curr}`)!;
          describe.unshift(s.name);
          curr = s.parentId;
        }
        if (describe.length === 0 && data.parentId === undefined && typeof data.nesting === "number" && data.nesting > 0) {
          describe.push(...(startStacks.get(file) ?? []).slice(0, data.nesting));
        }

        const isAssert = isAssertionFailure(data.details?.error);
        const list = testsByFile.get(file) ?? [];
        list.push({
          file,
          name: data.name,
          describe,
          status: isAssert ? "assertion" : "error",
          errorDetail: isAssert ? undefined : data.details?.error?.message || "error",
        });
        testsByFile.set(file, list);
      }

      if (event.type === "test:pass") {
        if (data.details?.type === "suite") continue;

        const isFileLevel =
          data.name === data.file ||
          ((data.parentId === 0 || (data.parentId === undefined && data.nesting === 0)) &&
            rawFile &&
            data.name &&
            String(rawFile).replace(/\\/g, "/").endsWith(`/${data.name}`));
        if (isFileLevel) continue;

        const describe: string[] = [];
        let curr = data.parentId;
        while (curr && suiteParents.has(`${file}:${curr}`)) {
          const s = suiteParents.get(`${file}:${curr}`)!;
          describe.unshift(s.name);
          curr = s.parentId;
        }
        if (describe.length === 0 && data.parentId === undefined && typeof data.nesting === "number" && data.nesting > 0) {
          describe.push(...(startStacks.get(file) ?? []).slice(0, data.nesting));
        }

        const isSkip = Boolean(data.skip || data.details?.skip || data.todo);
        const list = testsByFile.get(file) ?? [];
        list.push({
          file,
          name: data.name,
          describe,
          status: isSkip ? "skip" : "pass",
        });
        testsByFile.set(file, list);
      }
    }

    if (!parsedAnyEvent) {
      return {
        ok: false,
        adapter: "node:test",
        tests: [],
        errors: [`test command failed to produce reporter output:\n${stderr || stdout}`],
        fileErrors: new Map(),
        rawOutput: `${stdout}\n${stderr}`,
      };
    }

    return validateResults(opts, "node:test", testsByFile, fileErrors, fileStderr, `${stdout}\n${stderr}`);
  } finally {
    try {
      if (existsSync(reporterPath)) unlinkSync(reporterPath);
    } catch {}
  }
}

export async function runSealedTests(opts: RunSealedTestsOptions): Promise<RunSealedTestsResult> {
  const testEnv: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  delete testEnv["NODE_TEST_CONTEXT"];
  delete testEnv["VITEST"];

  const adapter = detectAdapter(opts.template);

  if (adapter === "exit") {
    return runExitMode(opts, testEnv);
  }

  if (adapter === "vitest") {
    return runVitestMode(opts, testEnv);
  }

  return runNodeTestMode(opts, testEnv);
}

export async function runRedCheck(opts: RunRedCheckOptions): Promise<RunRedCheckResult> {
  const executor = opts.executor ?? localExecutor;
  const res = await runSealedTests({
    executor,
    dir: opts.worktreeDir,
    files: opts.testFiles,
    template: opts.testCommandTemplate,
    mode: "red",
    env: opts.env,
  });

  const red: SealRedTest[] = res.tests
    .filter((t) => t.status === "assertion")
    .map((t) => ({
      file: t.file,
      describe: t.describe,
      name: t.name,
      failure: "assertion",
    }));

  return {
    ok: res.ok,
    adapter: res.adapter,
    red,
    errors: res.errors,
    ...(res.warnings ? { warnings: res.warnings } : {}),
  };
}
