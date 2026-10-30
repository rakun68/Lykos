// P4 T148 — `lykos-repo-map`, the first default extension.
//
// The repo map (T69, `context/repo-map.ts`) used to be a Lykos head block,
// switched by `flags.retrieval` and assembled inside `session/boot.ts`. It is
// now a Pi extension that ships inside Lykos's package and is switched like a
// third-party package: by being listed in `extensions:` (GLOSSARY.md, "Default
// extension").
//
// **Public Pi API only** (spec story 26). It uses exactly what Pi's own
// `examples/extensions/claude-rules.ts` uses to add to the prompt:
// `before_agent_start` returning `systemPrompt`, plus `appendEntry` to record
// what it added and `ctx.sessionManager.getEntries()` to find that record
// again. Nothing here reaches into Lykos's session; anything it does, a third
// party's extension can do.
//
// **Once per session, frozen** (spec story 28, AGENTS.md rule 9). The map is
// built on the first `before_agent_start` — the first moment Pi hands an
// extension the session's cwd with a prompt about to be sent — and closed over.
// Every later turn appends the same bytes to the same base prompt, so the
// system prompt, and the provider's cache of it, is identical across turns.
// It is not rebuilt when the agent edits a file (the agent knows what it
// changed). A session that already holds a record (a resumed one) reuses that
// record's text rather than building a different map from a newer tree.
//
// Not `session_start`: Pi fires that from `bindExtensions`, which a Lykos
// session does not call, so an outline built there would never be built.
//
// **Its switch is its `extensions:` entry, and nothing else** (T158,
// ADR-0028). It ships off — absent from the shipped list — so a project turns
// it on by listing it. Its parameters (`retrieval.repo_map`) are carried in by
// `REPO_MAP_POLICY_ENV`, which boot sets before Pi loads extensions; loaded, it
// is on. Loaded outside Lykos, with no policy in the environment, it builds
// the map with its shipped parameters.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildRepoMap,
  decodeRepoMapPolicyEnv,
  DEFAULT_MAX_FILES_PER_DIR,
  DEFAULT_MAX_TOKENS,
  REPO_MAP_ENTRY_TYPE,
  REPO_MAP_POLICY_ENV,
  repoMapFromEntries,
  type RepoMap,
  type RepoMapPolicy,
} from "../../context/repo-map.js";

export default function lykosRepoMap(pi: ExtensionAPI): void {
  // Read once, at load: a later session in the same process sets its own.
  const policy: RepoMapPolicy = decodeRepoMapPolicyEnv(process.env[REPO_MAP_POLICY_ENV]) ?? {
    enabled: true,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxFilesPerDir: DEFAULT_MAX_FILES_PER_DIR,
  };
  let frozen: RepoMap | undefined;

  pi.on("before_agent_start", (event, ctx) => {
    if (!policy.enabled) return undefined;
    if (frozen === undefined) {
      const recorded = repoMapFromEntries(ctx.sessionManager.getEntries());
      if (recorded.enabled) {
        frozen = recorded;
      } else {
        frozen = buildRepoMap(ctx.cwd, policy);
        pi.appendEntry(REPO_MAP_ENTRY_TYPE, frozen);
      }
    }
    if (frozen.text.length === 0) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${frozen.text}` };
  });
}
