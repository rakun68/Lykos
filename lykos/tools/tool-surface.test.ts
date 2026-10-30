import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRiskTier } from './tool-risk.js';
import {
  PI_DEFAULT_PLUS_SUBAGENTS,
  PI_DEFAULT_TOOLS,
  measureToolset,
  piDefaultBaseline,
  piDefaultPlusSubagentsBaseline,
} from "../ledger/tool-schema.js";
import {
  DEFAULT_RESIDENT_TOOLS,
  MOUNTED_SUBAGENT_TOOLS,
  MOUNTED_TOOLS,
  REGISTRY_OFF_TOOLS,
  PI_DELEGATE_OMIT_TOOLS,
  SUBAGENT_WORKFLOW_TOOL,
  TOOL_REGISTRY,
  fullSubagentsMeasurement,
  matchesDocumentedSurface,
  omitToolsMeasurement,
  resolveResidentTools,
  resolveSessionTools,
  workerPlusHostMeasurement,
  workerSurfaceMeasurement,
  workflowOnlyMeasurement,
} from './tool-surface.js';

const here = dirname(fileURLToPath(import.meta.url));

describe("T20.2 documented resident surface", () => {
  // P10.4 (ticket 13, D4) widened this set from four names to seven, and the
  // expectation is updated deliberately rather than relaxed. Each addition
  // has its own reason to ride every request:
  //
  //   grep       — the search a coding agent reaches for before anything
  //                else. Making it mounted would put a `tool_call` round trip
  //                in front of the most-used read in the session, and its
  //                results used to carry a [path#TAG] line (T168 removed it).
  //                Mounted, grep would put a `tool_call` round trip in front
  //                of every search.
  //   powershell — the host is Windows. A shell the model must discover
  //                through `tool_search` is a shell it will not use, and
  //                `bash` is not a substitute on the maintainer's own machine.
  //   glob       — finding files by name is the other half of finding them by
  //                content; splitting the pair across resident and mounted
  //                would make the cheaper of the two the harder to reach.
  //
  // `find` and `ls` stayed mounted for the mirror-image reason: `find` is
  // `glob`'s implementation under Pi's name, so a resident `find` would be a
  // second schema for one tool, and `ls` is answerable by either of them.
  //
  // P10.7 (ticket 12, D10) widened it again, from seven names to nine, and
  // this is the first time since P10.4 that the resident set has moved at all
  // — everything built in P10.5 and P10.6 is mounted. The two additions are
  // the ticket's own argument:
  //
  //   web_search — a model that has to DISCOVER how to search will not search;
  //                it will answer from training data about a library that
  //                shipped a major version last month.
  //   web_fetch  — the other half of the same pair. A search whose results
  //                cannot be read is a list of URLs, and a fetcher reached
  //                through tool_call puts a round trip in front of every page.
  it("is the Pi four plus grep, powershell, glob and the web pair", () => {
    assert.deepEqual([...DEFAULT_RESIDENT_TOOLS], ['read', 'bash', 'edit', 'write', 'commit', 'grep', 'powershell', 'glob', 'web_search', 'web_fetch']);
    assert.deepEqual([...DEFAULT_RESIDENT_TOOLS].slice(0, 4), [...PI_DEFAULT_TOOLS]);
    for (const name of DEFAULT_RESIDENT_TOOLS) {
      const entry = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(entry, name + ' missing from registry');
      assert.ok(entry.rationale.length > 0, name + ' missing rationale');
      assert.doesNotMatch(entry.rationale, new RegExp(String.fromCharCode(92) + 'n'), name + ' rationale is not one line');
    }
  });

  it("non-resident and unbuilt resident tools are not in default resident tools", () => {
    const nonDefault = TOOL_REGISTRY.filter((e) => !DEFAULT_RESIDENT_TOOLS.includes(e.name));
    for (const row of nonDefault) {
      assert.ok(row.rationale.length > 0, row.name + ' missing rationale');
    }
    const resident = resolveResidentTools();
    for (const entry of nonDefault) {
      assert.equal(resident.includes(entry.name), false, entry.name + ' should not be in default resident tools');
    }
  });

  // P10.4 D6: re-examined, unchanged. This list is what the retired delegate server
  // registered when `tools` was omitted — a pinned third-party package's
  // behaviour, not a Lykos policy — so three of its four names becoming
  // Lykos-owned wrappers does not move it. The constant's own comment carries
  // the full reasoning; this pins that it did not quietly change.
  it("the omit-tools default (read, grep, find, ls) is not the post-trim surface", () => {
    assert.deepEqual([...PI_DELEGATE_OMIT_TOOLS], ['read', 'grep', 'find', 'ls']);
    assert.equal(matchesDocumentedSurface(PI_DELEGATE_OMIT_TOOLS), false);
    assert.equal(matchesDocumentedSurface(DEFAULT_RESIDENT_TOOLS), true);
  });
});

describe("T20.3 pi-subagents keep-or-reconsider", () => {
  it("keeps the host trio and drops SubagentWorkflow from the resident allowlist", () => {
    const withHost = resolveResidentTools({ subagents: true });
    // P10.7 (ticket 12): the web pair sits where the registry puts it, which
    // is before the host trio rather than appended after it.
    assert.deepEqual(withHost, [
      'read',
      'bash',
      'edit',
      'write',
      'commit',
      'grep',
      'powershell',
      'glob',
      'web_search',
      'web_fetch',
      'agent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    assert.equal(withHost.includes(SUBAGENT_WORKFLOW_TOOL), false);
    assert.equal(MOUNTED_SUBAGENT_TOOLS.length, 3);
    for (const name of MOUNTED_SUBAGENT_TOOLS) {
      const entry = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(entry && entry.rationale.length > 0);
    }
  });

  // P10.4 (ticket 13, D4): `find` and `ls` are mounted, and opting into
  // subagents must not drag them onto the wire. Mounted is not one bucket —
  // the host trio is `named` in the prompt and joins the allowlist, the
  // search pair is `hidden` and is reached only through `tool_call`. Before
  // this ticket every mounted tool was a subagent tool and the distinction
  // cost nothing; now getting it wrong would add 273 measured tokens to every
  // request of every subagent-host session for two tools it was told not to
  // put in the prompt.
  // P10.4 (ticket 14, D8): `ast_grep` and `ast_edit` joined the mounted set
  // on exactly the same terms — `hidden` presence, reached through
  // `tool_call` — so the list grew by two. The assertion that this test is
  // named after is the one below it: whatever else is mounted, opting into
  // subagents must put only the `named` trio on the allowlist.
  // P10.4 (ticket 15, D9): `lsp` joined them on the same terms when it was
  // built, so the list grew by one again.
  // P10.5 (ticket 16, D10): and `hub` joined them on exactly the same terms,
  // so it grew by one more. `hub start` runs an arbitrary command line, which
  // is the strongest reason yet for the assertion below: opting into subagents
  // must not put a background shell in every subagent's prompt.
  // P10.6 (ticket 18): the five memory tools joined on the same terms, and
  // ticket 19's `eval` and `github` after them — `eval` runs arbitrary code
  // and `github` can publish a branch, which are the two strongest reasons yet
  // for the assertion below.
  // P10.6 (ticket 20, D9): and the nine session and context tools, on exactly
  // the same terms, taking the mounted set from sixteen names to twenty-five.
  // `new_context` spawns a child session, which is the same reason `Agent` is
  // `named` and this one is not: a sub-context is something the model reaches
  // for deliberately, not something every subagent should carry a schema for.
  it("every mounted tool but the named host trio stays off the allowlist, including with subagents on", () => {
    assert.deepEqual(
      [...MOUNTED_TOOLS],
      ['agent', 'get_subagent_result', 'steer_subagent', 'find', 'ls', 'ast_grep', 'ast_edit', 'lsp', 'eval', 'github', 'hub',
       'checkpoint', 'rewind', 'context_notes', 'new_context', 'manage_skill', 'skill', 'security_scan', 'yield', 'goal', 'think',
       'retain', 'recall', 'reflect', 'memory_edit', 'learn'],
    );
    for (const hidden of ['find', 'ls', 'ast_grep', 'ast_edit', 'lsp', 'eval', 'github', 'hub',
                          'checkpoint', 'rewind', 'context_notes', 'new_context', 'manage_skill', 'skill',
                          'security_scan', 'yield', 'goal', 'think',
                          'retain', 'recall', 'reflect', 'memory_edit', 'learn']) {
      assert.equal(MOUNTED_SUBAGENT_TOOLS.includes(hidden), false, hidden);
      for (const surface of [resolveResidentTools(), resolveResidentTools({ subagents: true })]) {
        assert.equal(surface.includes(hidden), false, hidden);
      }
    }
  });

  it("SubagentWorkflow is almost all of the T4.1 7453-token catalog delta", () => {
    const without = piDefaultBaseline();
    const withExt = piDefaultPlusSubagentsBaseline();
    const delta = withExt.tokens - without.tokens;
    const workflow = workflowOnlyMeasurement();
    assert.ok(workflow.complete && workflow.tokens !== null);
    // Array wrapping means measure(A+B) !== measure(A)+measure(B); the
    // session tax is the 8-tool payload minus the 4-tool payload.
    assert.equal(delta, 7454);
    // P10.4 (ticket 13): measured against the SAME eight names minus
    // SubagentWorkflow, not against Lykos's live host surface. That surface
    // gained grep/powershell/glob in this ticket, and comparing a bigger
    // surface with a smaller one would credit the trim with a saving the
    // trim did not make — the question here is what dropping one tool saves,
    // and it has to be asked with everything else held still.
    const withoutWorkflow = measureToolset(
      PI_DEFAULT_PLUS_SUBAGENTS.filter((n) => n !== SUBAGENT_WORKFLOW_TOOL),
    );
    assert.ok(withoutWorkflow.complete && withoutWorkflow.tokens !== null);
    const savedByDroppingWorkflow = withExt.tokens - withoutWorkflow.tokens;
    assert.ok(
      savedByDroppingWorkflow > 5000,
      `dropping SubagentWorkflow should save the bulk of the tax, saved=${savedByDroppingWorkflow} rest=${withoutWorkflow.tokens}`,
    );
    assert.ok(
      savedByDroppingWorkflow / delta > 0.7,
      `SubagentWorkflow should be most of the 7453-token delta, share=${savedByDroppingWorkflow / delta}`,
    );
    // Solo-tool estimate is a lower bound (no sibling wrapping); still thousands.
    assert.ok(
      (workflow.tokens as number) > 4000,
      `expected SubagentWorkflow to be large even alone, got ${workflow.tokens}`,
    );
  });

  // P10.3 moved these figures once and P10.4 moved them again. P10.3's move
  // was `edit`: the catalog row was Lykos's hash-anchored tool (replaced by T168's text replacement, +35 across edit and read), 129 tokens
  // larger than Pi's, so the four-tool surface went 711 -> 840 and the
  // eight-tool one 8164 -> 8293. P10.4's move is three more resident tools —
  // grep, powershell and glob — so the resident surface is no longer the Pi
  // four at all and is priced accordingly. Nothing was backfilled: every
  // number here was re-measured from the catalog on 2026-09-21 with
  // `measureToolset`, the same way the originals were.
  // P10.7 (ticket 12) moves them a third time, and this is the move to read
  // carefully: `web_search` and `web_fetch` are RESIDENT, so the seven-tool
  // surface becomes a nine-tool one and 1423 becomes 2062 — 314 and 326 priced
  // alone, 639 together once the array wrapping is counted once instead of
  // twice. Re-measured from the catalog on 2026-09-21 with `measureToolset`,
  // the same way every figure above it was.
  it("the resident surface is the Pi four plus P10.4's three and P10.7's two, priced as nine", () => {
    const worker = workerSurfaceMeasurement();
    const t41 = piDefaultBaseline();
    assert.equal(t41.tokens, 875);
    assert.equal(worker.count, 10);
    assert.equal(worker.tokens, 2255);
    // The resident surface is a superset of Pi's default four, so it must
    // cost more than it; an assertion on the direction as well as the figure,
    // because a figure alone cannot say a swap went the wrong way.
    assert.ok(worker.tokens > t41.tokens);
    assert.equal(fullSubagentsMeasurement().tokens, 8329);
  });
});

describe("resolveSessionTools", () => {
  it("defaults to the worker four", () => {
    assert.deepEqual(resolveSessionTools(), [...DEFAULT_RESIDENT_TOOLS]);
  });

  it("caller override wins entirely, including SubagentWorkflow and an empty list", () => {
    assert.deepEqual(resolveSessionTools({ tools: ["read"] }), ["read"]);
    assert.deepEqual(resolveSessionTools({ tools: [] }), []);
    assert.deepEqual(resolveSessionTools({ tools: ["read", SUBAGENT_WORKFLOW_TOOL], subagents: true }), [
      "read",
      SUBAGENT_WORKFLOW_TOOL,
    ]);
  });

  it("subagents is ignored when the caller passed tools", () => {
    assert.deepEqual(resolveSessionTools({ tools: ["read"], subagents: true }), ["read"]);
  });
});

describe("matchesDocumentedSurface", () => {
  // P10.4: the documented surface is seven names now, so the Pi four on its
  // own no longer matches it. That is the point of the function — it answers
  // "is this session running the surface Lykos documents", and a session
  // still on the old four is not, however reasonable that list looks.
  it("accepts the resident surface and the resident surface plus the host trio, in API order only", () => {
    const resident = ["read", "bash", "edit", "write", "commit", "grep", "powershell", "glob", "web_search", "web_fetch"];
    assert.equal(matchesDocumentedSurface(undefined), false);
    assert.equal(matchesDocumentedSurface(resident), true);
    assert.equal(
      matchesDocumentedSurface([...resident, "agent", "get_subagent_result", "steer_subagent"]),
      true,
    );
    assert.equal(matchesDocumentedSurface(["read", "bash", "edit", "write"]), false);
    assert.equal(matchesDocumentedSurface(["bash", "read", "edit", "write", "commit", "grep", "powershell", "glob", "web_search", "web_fetch"]), false);
    // P10.7: the seven-name surface is not the documented one any more, for
    // exactly the reason the Pi four stopped being it in P10.4.
    assert.equal(matchesDocumentedSurface(["read", "bash", "edit", "write", "commit", "grep", "powershell", "glob"]), false);
    assert.equal(matchesDocumentedSurface([...resident, SUBAGENT_WORKFLOW_TOOL]), false);
    assert.equal(matchesDocumentedSurface(["read", "grep", "find", "ls"]), false);
  });
});

describe("T20.1 is T4.1 — do not rebuild the measurement", () => {
  it("v_schema_tax and schemaShareOfPrompt remain the per-session share path", () => {
    const schemaSql = readFileSync(join(here, "..", "ledger", "schema.sql"), "utf8");
    assert.match(schemaSql, /CREATE VIEW IF NOT EXISTS v_schema_tax/);
    assert.match(schemaSql, /share_of_prompt/);
    const toolSchema = readFileSync(join(here, "..", "ledger", "tool-schema.ts"), "utf8");
    assert.match(toolSchema, /export function schemaShareOfPrompt/);
  });

  it("the omit-tools default is a real catalog number, distinct from the worker four", () => {
    const before = omitToolsMeasurement();
    const after = workerSurfaceMeasurement();
    assert.ok(before.complete && after.complete);
    assert.notEqual(before.hash, after.hash);
    assert.notEqual(before.tokens, after.tokens);
  });
});

describe("tool registry rationale", () => {
  it("every surviving justification is one line, including the host trio", () => {
    for (const row of TOOL_REGISTRY.filter((e) => e.residency === 'resident' || e.residency === 'mounted')) {
      assert.equal(row.rationale.includes(String.fromCharCode(10)), false, row.name);
    }
  });
});

describe("catalog specialists used in DECISIONS.md T20", () => {
  it("before/after catalog tokens are complete measurements, not guesses", () => {
    const omit = omitToolsMeasurement();
    const worker = workerSurfaceMeasurement();
    const host = workerPlusHostMeasurement();
    const full = fullSubagentsMeasurement();
    assert.equal(omit.count, 4);
    assert.equal(worker.count, 10);
    assert.equal(host.count, 13);
    assert.equal(full.count, 8);
    // P10.4 (ticket 13) re-measured all four on 2026-09-21. `worker` and
    // `host` each gained the same 583 tokens: grep (261), glob (185) and
    // powershell (140) priced alone, less the array wrapping that
    // measuring them together saves — measure(A+B) is not measure(A) +
    // measure(B), which is why the surface is measured whole.
    //
    // `omit` moved by -4, and that one is a CORRECTION rather than a change:
    // its `ls` row carried `"required": []`, and Pi's typebox schema emits no
    // `required` key when nothing is required, so 14 bytes of wire payload
    // were being priced that Pi never sends. The parity test in
    // `tools/search.test.ts` is what found it, and it is the reason that test
    // compares against the live definition instead of a transcription.
    //
    // P10.7 (ticket 12) re-measured all four again on 2026-09-21. `worker` and
    // `host` each gained the web pair — 639 and 638 tokens respectively, the
    // one-token difference being the array wrapping paid across a different
    // number of siblings. `omit` and `full` did not move at all, and could
    // not: the first is a pinned third-party package's default and the second
    // is Pi's own eight, neither of which has anything to do with what Lykos
    // makes resident.
    //
    // Ticket 24 (bfbf3cb) shortened web_search's description, 314 -> 309
    // alone. It moved `worker` 2062 -> 2057 and pinned that, and left `host`
    // at 4201; re-measured 2026-09-25 at 4197. The Agent -> agent rename
    // (792431f) is not the cause: the same surface measures 4197 under
    // either spelling.
    //
    // T179 (P15) made `commit` resident: `worker` 2092 -> 2255 (`commit` priced alone is
    // 163 tokens), `host` 4232 -> 4395. `full` is Pi's
    // own eight and did not move.
    //
    // T168 (ADR-0031) re-measured them on 2026-10-05. `edit` gained `replaceAll`
    // and `read` gained a sentence about its line numbers: `worker` 2057 -> 2092,
    // `host` 4197 -> 4232 and `full` 8294 -> 8329, +35 each, and the Pi four 840 ->
    // 875. `omit` did NOT move, on purpose: it prices what the retired delegate server registered,
    // with Pi's own `read` row, so its recorded 704 stays 704.
    assert.equal(omit.tokens, 704);
    assert.equal(worker.tokens, 2255);
    assert.equal(host.tokens, 4395);
    assert.equal(full.tokens, 8329);
  });
});

describe('P10.1 registry residency and prompt presence', () => {
  it('every row in the registry carries risk, residency and promptPresence', () => {
    assert.equal(TOOL_REGISTRY.length, 44);
    for (const entry of TOOL_REGISTRY) {
      assert.ok(entry.name && entry.name.length > 0, 'tool has a name');
      assert.ok(entry.rationale && entry.rationale.length > 0, entry.name + ' missing rationale');
      assert.equal('lifecycle' in entry, false, entry.name + ' still has lifecycle property');
      assert.ok(entry.risk, entry.name + ' missing risk');
      assert.ok(isRiskTier(entry.risk.tier), entry.name + ' has invalid risk tier: ' + entry.risk.tier);
      assert.equal(typeof entry.risk.idempotent, 'boolean', entry.name + ' missing idempotent boolean');
      assert.equal(typeof entry.risk.openWorld, 'boolean', entry.name + ' missing openWorld boolean');
      assert.ok(entry.residency === 'resident' || entry.residency === 'mounted' || entry.residency === 'off', entry.name + ' invalid residency: ' + entry.residency);
      assert.ok(entry.promptPresence === 'full' || entry.promptPresence === 'named' || entry.promptPresence === 'hidden', entry.name + ' invalid promptPresence: ' + entry.promptPresence);
    }
  });
  it('every tool named in the spec set has a row', () => {
    const expected = ['read', 'bash', 'edit', 'write', 'commit', 'agent', 'get_subagent_result', 'steer_subagent', 'grep', 'find', 'ls', 'powershell', 'subagent_workflow', 'glob', 'ast_grep', 'ast_edit', 'lsp', 'eval', 'github', 'hub', 'checkpoint', 'rewind', 'context_notes', 'new_context', 'manage_skill', 'skill', 'security_scan', 'web_search', 'web_fetch', 'yield', 'goal', 'think', 'retain', 'recall', 'reflect', 'memory_edit', 'learn', 'todo', 'ask', 'exit_plan', 'tool_search', 'tool_call', 'ask_coordinator', 'give_up'];
    const registered = TOOL_REGISTRY.map((e) => e.name);
    assert.deepEqual(registered, expected);
  });
  it('the documented resident set matches the spec and has full prompt presence', () => {
    const resident = TOOL_REGISTRY.filter((e) => e.residency === 'resident');
    const residentNames = resident.map((e) => e.name);
    // P10.7 (ticket 12): `web_search` and `web_fetch` moved off -> resident,
    // where the registry already had their rows, so they appear in registry
    // order rather than at the end.
    const expectedResident = ['read', 'bash', 'edit', 'write', 'commit', 'grep', 'powershell', 'glob', 'web_search', 'web_fetch', 'todo', 'ask', 'exit_plan', 'tool_search', 'tool_call', 'ask_coordinator', 'give_up'];
    assert.deepEqual(residentNames, expectedResident);
    for (const row of resident) {
      assert.equal(row.promptPresence, 'full', row.name + ' resident tool should have full prompt presence');
    }
  });
  it('the mounted set matches the spec and has expected prompt presence', () => {
    const mounted = TOOL_REGISTRY.filter((e) => e.residency === 'mounted');
    const mountedNames = mounted.map((e) => e.name);
    // P10.4: `ast_grep` and `ast_edit` moved from off to mounted in ticket 14
    // and `lsp` in ticket 15, each when it was built, which is what this list
    // is for. P10.5 ticket 16 moved `hub` the same way, P10.6 ticket 18 the
    // memory five, ticket 19 `eval` and `github`, and ticket 20 the nine
    // session and context tools.
    assert.deepEqual(mountedNames, ['agent', 'get_subagent_result', 'steer_subagent', 'find', 'ls', 'ast_grep', 'ast_edit', 'lsp', 'eval', 'github', 'hub',
       'checkpoint', 'rewind', 'context_notes', 'new_context', 'manage_skill', 'skill', 'security_scan', 'yield', 'goal', 'think',
       'retain', 'recall', 'reflect', 'memory_edit', 'learn']);
    for (const row of mounted) {
      if (row.name === 'agent' || row.name === 'get_subagent_result' || row.name === 'steer_subagent') {
        assert.equal(row.promptPresence, 'named', row.name + ' host tool should have named prompt presence');
      } else {
        assert.equal(row.promptPresence, 'hidden', row.name + ' should have hidden prompt presence');
      }
    }
  });
  it('unbuilt tools outside resident and mounted sets are off and hidden', () => {
    const off = TOOL_REGISTRY.filter((e) => e.residency === 'off');
    // 24 before P10.4, which built `ast_grep` and `ast_edit` in ticket 14 and
    // `lsp` in ticket 15 and moved all three to mounted; 21 until P10.5
    // ticket 16 shipped `hub` and moved it too. The count is the whole point
    // of the row — an `off` tool is one `tool_call` refuses — so it moves when
    // a tool ships, and never for any other reason.
    // P10.6's ticket 18 built the five memory tools and moved all five to
    // mounted, so twenty becomes fifteen; ticket 19 then built `eval` and
    // `github` and moved both, so fifteen becomes thirteen; ticket 20 built
    // the nine session and context tools, so thirteen becomes four.
    // P10.7's ticket 12 built the web pair and moved both to RESIDENT rather
    // than mounted, so four becomes two; P10.8's ticket 23 built
    // `security_scan` and mounted it, so two becomes one.
    //
    // **That one is SubagentWorkflow, and it is off because it was dropped
    // rather than because it is unbuilt.** Every other tool the phase set out
    // to build now exists. An `off` count of one is therefore the phase's own
    // completeness check: if it ever rises, something shipped into the
    // registry without being built.
    assert.equal(off.length, 1);
    assert.deepEqual(off.map((e) => e.name), ['subagent_workflow']);
    for (const row of off) {
      assert.equal(row.promptPresence, 'hidden', row.name + ' off tool should have hidden prompt presence');
    }
  });
  it('fails when any row lacks risk, residency or promptPresence', () => {
    const checkRow = (r: any) => Boolean(r.risk && isRiskTier(r.risk.tier) && typeof r.risk.idempotent === 'boolean' && typeof r.risk.openWorld === 'boolean' && (r.residency === 'resident' || r.residency === 'mounted' || r.residency === 'off') && (r.promptPresence === 'full' || r.promptPresence === 'named' || r.promptPresence === 'hidden'));
    assert.equal(checkRow({ name: 't', rationale: 'r', residency: 'resident', promptPresence: 'full' }), false);
    assert.equal(checkRow({ name: 't', rationale: 'r', risk: { tier: 'read', idempotent: true, openWorld: false }, promptPresence: 'full' }), false);
    assert.equal(checkRow({ name: 't', rationale: 'r', risk: { tier: 'read', idempotent: true, openWorld: false }, residency: 'resident' }), false);
  });
  it('REGISTRY_OFF_TOOLS lists exactly the tools with off residency', () => {
    // 24 before P10.4 built the two AST tools and `lsp`, and 21 before P10.5
    // built `hub`; this list is what `tool_call` refuses, so a shipped tool
    // has to leave it.
    // Five fewer after P10.6's memory tools shipped, two fewer again once
    // ticket 19 shipped `eval` and `github`, and nine fewer after ticket 20:
    // 13 -> 4.
    // P10.7: two fewer again, now that the web pair has shipped — 4 -> 2.
    // P10.8: one fewer, now that security_scan has — 2 -> 1.
    assert.equal(REGISTRY_OFF_TOOLS.length, 1);
    assert.ok(!REGISTRY_OFF_TOOLS.includes('web_search'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('web_fetch'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('hub'));
    assert.ok(REGISTRY_OFF_TOOLS.includes('subagent_workflow'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('eval'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('github'));
    for (const shipped of ['checkpoint', 'rewind', 'context_notes', 'new_context', 'manage_skill', 'skill', 'yield', 'goal', 'think']) {
      assert.ok(!REGISTRY_OFF_TOOLS.includes(shipped), shipped);
    }
    assert.ok(!REGISTRY_OFF_TOOLS.includes('read'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('agent'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('ast_grep'));
    assert.ok(!REGISTRY_OFF_TOOLS.includes('ast_edit'));
  });
});
