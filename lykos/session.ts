// `session/` — configuration becomes a running session.
//
// Boot lives here, matching the target map: session assembly plus today's
// Session assembly and archive live here (`session/`).
//
// Feature flags (loader, ask, plan, checkpoints, skills, memory, hooks) are
// read once, inside `boot`, not threaded through the one-shot driver or the
// interactive loop.

export {
  boot,
  buildAppendSystemPromptOverride,
  contextWindowOf,
  startLiveCapture,
  type BootConfig,
  type BootDeps,
  type BootedStandaloneSession,
} from "./session/boot.js";
