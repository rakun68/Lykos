# The `lsp` tool

A mounted tool (reached through `tool_call`) that asks a language server rather than guessing from a
text search. Source: `lykos/tools/lsp.ts` (the tool) and `lykos/tools/lsp-client.ts` (one client per
server, and the pool that owns them for a session).

## Configuration

`lsp.servers` in `.lykos/config.yaml`, merged by key across layers: each entry is
`{ command, args?, extensions }`, and a file is sent to the server whose `extensions` include its
own. The shipped table has one entry, `typescript` (`typescript-language-server --stdio`). A file
with no server gets ordinary text naming `lsp.servers`, not an error.

## Trust, and workspace binaries (T171)

`lsp` runs on the host, so a server program that lives inside the workspace (a `node_modules` bin, or a
workspace file named in `args`, including `--opt=path`) is the project's own code. It starts only when the
project is trusted in the **user-level trust store** (`~/.lykos/trust.json`, written by the trust prompt).
`--trust-workspace` and `LYKOS_TRUST_WORKSPACE=1` let a headless run pass the trust gate and never authorise
this: a project in the store reports `stored` even when the flag is set, and a flag-only run reports `flag`,
which leaves workspace binaries refused. The refusal names the binary. A server found outside the workspace
starts either way. The file tools separately refuse any path that resolves outside the workspace.

## Actions

`definition`, `references`, `hover`, `symbols`, `diagnostics`, `rename` and `status`. A position is
`file` + `line` (1-indexed) + `symbol` (a substring on that line; `name#2` for the second
occurrence). `rename` is one approval for the whole workspace edit and is all-or-nothing; its result
carries `details.changedFiles`, the files it wrote (T159). `timeout` (seconds) caps both the
project-load wait and the request that follows.

## Readiness, and the not-ready error (T160)

A server that is asked about a document before it has loaded the project answers anyway, and the
answer looks valid: a definition inside the wrong file, an empty rename, an empty diagnostics list
for a broken file. So every action opens the document and waits for the server's first
`publishDiagnostics` for it — a server publishes for a file once it has a program that contains
it — for up to `LSP_PROJECT_LOAD_TIMEOUT_MS` (15 s) or the call's `timeout`.

If nothing is published in that window, **nothing is asked of the server**. The call fails with an
error the model sees:

```text
lykos lsp: language server not ready — typescript has not finished loading the project for src/a.ts
within 15s, so nothing was answered: an answer given before the project loads can look valid and be
wrong. It keeps loading in the background; retry the same call, or pass a larger `timeout`.
```

The server keeps running, and a document stays unready until a publish arrives, so a retry waits
again rather than being answered early. `diagnostics` reopens the file so it describes what is on
disk now; if that reopen gets no publish within its wait (`LSP_DIAGNOSTICS_WAIT_MS`, 5 s, or
`timeout`), it is the same not-ready error, never an empty list that reads as clean.

The post-edit loop does not use `lsp` at all: it runs a command (`feedback.command`, else the
project's typecheck script), so no language-server result can ever be read there as a pass.

A request that outlives its own timeout (`LSP_REQUEST_TIMEOUT_SECONDS`, 20 s) is a different
error (`did not answer … within`), and also leaves the server running.
