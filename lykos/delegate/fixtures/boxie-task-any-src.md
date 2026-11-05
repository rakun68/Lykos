---
files: [lykos/gate/approval.ts, lykos/session/boot.ts, lykos/session/session.ts, lykos/tools/spawn.ts, lykos/tools/workspace-confine.ts, lykos/extensions/api.ts, lykos/gate/delegated.ts, lykos/tools/gated.ts, lykos/tools/tool-call.ts, lykos/cli/session-child.ts, lykos/delegate/mcp-server.ts, lykos/ledger/prices.ts, lykos/providers/gitlab-duo/oauth.ts, lykos/providers/gitlab-duo/stream.ts, lykos/providers/gitlab-duo-agent/oauth.ts, lykos/providers/logins.ts, lykos/providers/muse/oauth.ts, lykos/seal/active.ts, lykos/seal/create.ts, lykos/seal/runner.ts]
red: false
test: "npx --no-install tsc --noEmit --incremental --tsBuildInfoFile /tmp/tsbuildinfo && npx tsx --test lykos/gate/*.test.ts lykos/seal/*.test.ts lykos/providers/*/*.test.ts lykos/cli/session-child.test.ts lykos/delegate/mcp-server.test.ts lykos/extensions/api.test.ts lykos/ledger/prices.test.ts lykos/session/boot.test.ts lykos/tools/spawn.test.ts lykos/tools/tool-call.test.ts lykos/tools/workspace-confine.test.ts"
---
Remove the TypeScript `any` type from the non-test source files listed in `files`. Pure type refactor: no runtime behaviour changes.

Sites (from a hunt; re-grep, the list may be incomplete):
- Gate casts, one root cause. `(gate as any).mode`, `.denied`, `.refresh` in gate/approval.ts:378,382,511-512,540-541,666-667; session/boot.ts:1103,1363-1364,1609-1610; session/session.ts:1425-1426,1855; tools/spawn.ts:336-337; tools/workspace-confine.ts:108-109; extensions/api.ts:1274-1276. Add optional members to `ApprovalGate` (gate/approval.ts:152) with the real types the implementing gate classes already use (find them: the `mode` type is `InteractionMode` or similar, `denied` is the denial array type, `refresh(): void`). Then delete every cast. Keep the existing runtime guards (`Array.isArray`, `!== undefined`, `isInteractionMode`) where they still narrow.
- tools/spawn.ts:343 `(resolvedSpecialist.file as any).path_rules`: add the field to the specialist file type if it is really there, else narrow.
- gate/delegated.ts:57 `req.kind as any`: the precise union type.
- tools/gated.ts:82 `ToolDefinition<any, any, any>[]`: try the Pi-exported default form or a named alias; if variance makes it impossible, keep it and say why in the report.
- tools/tool-call.ts:411 `validatedArgs as any`: try `as never` or the tool's declared param type.
- extensions/api.ts:873 `handler: any`: `unknown` (it is cast to the handler type below).
- Parsed JSON / YAML (providers/*/oauth.ts, providers/gitlab-duo/stream.ts, providers/logins.ts, seal/active.ts:163,343, seal/create.ts:79, seal/runner.ts:281,448, delegate/mcp-server.ts:483,484,546,721, cli/session-child.ts:535,688, ledger/prices.ts:66): declare a small interface for the shape the code already reads, or `unknown`/`Record<string, unknown>` with the narrowing the code already does. Ledger rows: use the exported row types if they exist. Do not add new validation that could reject input the code accepts today.

Rules:
- Use exported type names. Never introduce `ReturnType<>`, `Parameters<>` or inline `import("x").T` type imports; import the type at the top. Check node_modules/@earendil-works/pi-coding-agent for Pi types instead of guessing.
- Never replace `any` with `as unknown as X` double casts unless the value truly has no type relation; say where you did.
- Out of scope: test files, any other refactor, comments, formatting.
- Report each site: fixed with what, or kept and why.
