# A failed gate reruns its failed test files once

Decided by the maintainer on 2026-10-05, after a demonstration run.

## The decision

**When the session gate's command fails, the gate reruns only the failed test files, once.**

- **Fail again: `fail`.** The first verdict stands.
- **Pass: `success`, with the flaky tests named.** A test that failed in the first run and passed
  in the rerun is a flaky test. It goes in the ledger's `flaky_tests` table, in `lykos show`'s gate
  section, in the `verification_verdict` event, and on the screen line the gate prints.
- **Unless the session edited the test's file: then `fail`.** A session must not pass by writing a
  test that sometimes passes. The flaky test is still recorded, marked as edited. "Edited" is the
  session's own trace — the paths `edited_files` is written from — plus every path git reports
  changed since the session booted (tracked changes against the boot commit, and untracked files),
  and a directory the session edited counts for every file under it.
- **Output that cannot be parsed into at least one failed test file: no rerun, the first verdict
  stands.** So does a failed test whose file is not in the project, because a rerun that passed
  without covering that failure would hide it.
- **The parsed failures must account for every failure the reporter counted.** The reporter's own
  summary (`ℹ fail N` / `ℹ cancelled N` in spec, `# fail N` / `# cancelled N` in tap) must be
  readable, once, and the parsed failures must number at least `fail + cancelled`. Otherwise no
  rerun: a failure the parser missed (a crash with no `test at` line, a reporter quirk) would let
  a rerun of the other files pass and record `success` over it. Checked against real Node 24.11
  output: a failing test in a `describe` suite lists the suite but counts only the leaf; a suite
  whose `after` hook threw is listed with `fail 0`; a cancelled test is listed with
  `cancelled 1`; a file that crashed on load is listed and counted. All are accounted for. **A
  test (not a suite) that failed only because a `t.test` subtest did is counted in `fail` and not
  listed, and the spec reporter cannot tell it from a failed suite, so the counts disagree and
  the rerun is refused rather than guessed at.** The comparison is `>=`, so a missed failure
  hidden by an equally sized extra listing (a suite hook failure beside a missed test failure)
  would still pass it; that needs two independent anomalies in one run.
- **A rerun clears the failure only if its own output proves the tests ran and passed.** Exit 0
  is not enough, because a run that executed nothing exits 0 (a nested `node --test` that
  inherited `NODE_TEST_CONTEXT` did exactly that in the tests for this ticket). Its summary must be
  readable with `tests >= 1`, `fail 0`, `cancelled 0`, and `pass` at least the number of failed
  tests it vouches for. Otherwise it is treated as a failed rerun: `fail`, no flaky rows, and the
  screen line and `verification_output` say it exited 0 without showing the tests pass. This
  also means a `gate.rerun_command` for a non-node runner cannot clear a failure, since only
  node:test's summary is read.
- **Session gate only.** The post-edit loop and per-item verify do not rerun.
- **On by default, off with `gate.rerun_failures: false`.**
- **The rerun command is derived only when the test script is a plain `node --test` or `tsx --test`
  invocation** (optionally `npx tsx --test`). The script's runner and every flag, with its value,
  are kept in order; the script's file globs and directories are dropped; the failed files are
  appended. A bare `tsx` runs as `npx --no-install tsx`, because `tsx` is on `npm test`'s PATH and
  not on the gate's. A script with `&&`, a pipe, an environment prefix, `--watch` or another runner
  is not derivable. **`gate.rerun_command`, with `{files}` for the failed files, overrides the
  derivation** and must contain `{files}`. No derivable command and no override: no rerun.
- **`runVerify` stays the only writer of `outcome`.** The gate reports what the rerun found;
  `runVerify` applies the one rule that turns a failed first run into a success (rerun exited 0,
  at least one flaky test, none in an edited file) and writes the outcome and the flaky rows in one
  transaction. The ledger refuses a `success` beside a non-zero exit code in every other case.
- **`verification_exit_code` is the gate command's own exit code**, not the rerun's, so a `success`
  can sit beside `1`. The rerun's exit code, command and files are in the `verification_verdict`
  event and in `flaky_tests`.
- **Nothing is backfilled.** Run 2 stays `fail`.

## Why

A demonstration run (2026-10-05, session `01a10b29`) recorded `fail` for a change that was
correct. The suite exited 1 because of backlog D22: a Windows `EPERM` race in the `lsp.test.ts`
cleanup. The ledger's `outcome` column is the one cost and strength claims are built on, and a
flaky test made it say the opposite of what happened. Nothing could correct the row afterwards,
because an outcome is written once.

Rerunning the failed files is cheap, and it is evidence rather than an opinion: a test that passes
when run alone, after failing, did not fail because of the change. Naming it keeps the flake
visible, which is the point of recording it. A flake that is hidden never gets fixed.

## Rejected

- **Rerun the whole suite.** The suite takes 8–12 minutes here. The failed files take seconds, and
  they are the only thing in doubt.
- **Retry N times.** One rerun is enough to separate "failed once, passed" from "failed twice". More
  retries buy confidence about the flake and cost minutes, and a test that needs three tries to
  pass is one to fix, not to tolerate. N would also be a number nobody measured.
- **Mark known-flaky tests by hand.** A list a person maintains is a list that is out of date, and
  it hides the next flake until somebody notices. The ledger finds them as they happen.
- **Pass a flaky test in an edited file.** It would let a session pass by writing a test that
  sometimes passes.
- **Rerun on a parse of anything.** Only node:test's spec reporter (what `npm test` prints off a
  terminal on Node 24) and its tap reporter are read. Any other output reruns nothing.

## Consequences

- A project whose test script is not a plain `node --test` / `tsx --test` run gets no rerun until it
  sets `gate.rerun_command`.
- **Edits the session made through `bash` (`sed -i`, a script) are not in the trace's paths**, so
  the rerun also asks git (`sessionChangedPaths`, added 2026-10-06 after T167's review). A file that
  was already dirty when the session booted counts as edited too, which can only keep a verdict at
  `fail`. Outside a git repository only the trace is consulted, and a file only `bash` edited reads
  as not edited. `edited_files` in the ledger is still the trace's alone.
- A rerun's pass proves the file passed, not that the same tests ran: a failure located in a helper
  module that registers tests for another file reruns the helper. node:test locates a test where
  `it` was called, which is the test file in this repository.
- A rerun that fails does not name flaky tests, even if some of the first run's failures passed in
  it. That needs a second parse, and the session is `fail` either way.
- `lykos doctor` reports the count of flaky tests the ledger holds, as a warning.
