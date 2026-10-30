// "is this pid still a process?", asked of the operating system.
//
// **Why this exists at all.** D4 makes the grandchild kill the acceptance
// test for `hub`, and AGENTS.md rule 4 says an agent's self-report never
// counts as success. A kill's return code is a self-report: `taskkill` exits 0
// having asked the kernel nicely, `process.kill` returns `true` having queued
// a signal, and the registry's own `status: "stopped"` is a field this
// codebase sets itself. None of the three is evidence that a process is gone.
// So the tests that matter ask something outside this process instead.
//
// **It is deliberately not `process.kill(pid, 0)`.** That is the obvious
// spelling and it is the wrong one here. On Windows Node implements it with
// `OpenProcess`, which succeeds for a process that has already terminated
// while a handle to it is still open — so the one platform whose kill this
// ticket exists to get right is the one platform where the cheap probe can
// report a dead process as alive, or (worse, with a recycled handle) the
// reverse. `tasklist` and `ps` are the operating system's own answer to the
// question in the operating system's own words, so that is what is asked.
//
// **Nothing in the kill path imports this**, and nothing should. A probe the
// implementation also uses would let one bug hide another: the check would
// agree with the kill because they share the mistake. Its readers are tests,
// and each of them asserts the process is alive BEFORE the kill as well as
// dead after, so a probe that answered "gone" to everything would fail the
// positive control rather than pass the test vacuously.

import { execFile } from "node:child_process";

/** Long enough for a cold `tasklist` on a loaded Windows box; short enough that a hung probe fails the test rather than the suite. */
const PROBE_TIMEOUT_MS = 20_000;

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (err, stdout) => {
        // `ps -p` exits 1 when nothing matches, and `execFile` reports that as
        // an error. That is an ANSWER, not a failure, so the exit code is read
        // off the error rather than thrown.
        const code = (err as { code?: unknown } | null)?.code;
        resolvePromise({
          code: typeof code === "number" ? code : err ? 1 : 0,
          stdout: stdout ?? "",
        });
      },
    );
  });
}

/**
 * Whether the operating system still lists `pid` as a process.
 *
 * Windows: `tasklist /FI "PID eq <pid>" /NH /FO CSV`. A match prints a CSV row
 * containing the pid; no match prints `INFO: No tasks are running which match
 * the specified criteria.` and still exits 0, which is why the answer is read
 * from the text rather than from the exit code.
 *
 * POSIX: `ps -p <pid>`, which exits 0 when the process exists and non-zero
 * when it does not.
 */
export async function osProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
    // The pid appears as its own CSV field, `"1234"`. Matching the bare number
    // anywhere in the line would also match a memory figure such as "1,234 K".
    return stdout.includes(`"${pid}"`);
  }
  const { code } = await run("ps", ["-p", String(pid)]);
  return code === 0;
}

/**
 * Polls `osProcessAlive` until it answers `want`, or the window elapses.
 *
 * A kill is asynchronous on both platforms — `taskkill /F` returns once the
 * kernel has accepted the request, and a signalled POSIX process still has to
 * be reaped — so a single probe immediately after a kill can see a process
 * that is on its way out. This waits for the answer to settle rather than
 * sleeping a guessed amount, and returns what the OS last said so a caller
 * can assert on it either way.
 */
export async function waitForOsProcess(pid: number, want: boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = await osProcessAlive(pid);
    if (alive === want) return alive;
    if (Date.now() >= deadline) return alive;
    await new Promise((r) => setTimeout(r, 100));
  }
}
