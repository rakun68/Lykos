// Child process for store.test.ts's cross-process lease test.
//
// Opens the store on a shared db and runs a refresh through `modify`, the way
// Pi's `resolveStoredOAuth` does: refresh only if the credential it is handed
// still carries the original access token. Two children must overlap: each
// creates `<outPrefix>.ready`, waits for the parent to create a go file, so
// both call `modify` at the same moment whatever their start-up time, and
// sleeps 300 ms inside `fn`. Each refresh appends one line to a counter file,
// and the credential `modify` resolved with is written to `<outPrefix>.json`.
// It talks through files, not stdout (T32.2: stdout belongs to io-mode.ts).
//
// argv: <dbPath> <provider> <originalAccess> <refreshedAccess> <counterFile> <goFile> <outPrefix>

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { LykosCredentialStore } from "./pi-store.js";

const [dbPath, provider, originalAccess, refreshedAccess, counterFile, goFile, outPrefix] = process.argv.slice(2);
if (!dbPath || !provider || !originalAccess || !refreshedAccess || !counterFile || !goFile || !outPrefix) {
  process.stderr.write(
    "lease-child: expected <dbPath> <provider> <originalAccess> <refreshedAccess> <counterFile> <goFile> <outPrefix>\n",
  );
  process.exit(2);
}

writeFileSync(`${outPrefix}.ready`, "");
while (!existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 10));

const store = new LykosCredentialStore({ dbPath });
const result = await store.modify(provider, async (current) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (current?.type !== "oauth" || current.access !== originalAccess) return undefined;
  appendFileSync(counterFile, `${process.pid}\n`);
  return { ...current, access: refreshedAccess, refresh: `${refreshedAccess}-refresh`, expires: Date.now() + 3_600_000 };
});
writeFileSync(`${outPrefix}.json`, JSON.stringify({ access: result?.type === "oauth" ? result.access : null }));
