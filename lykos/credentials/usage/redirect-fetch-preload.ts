// Test support: loaded with `node --import` into a `lykos usage --refresh`
// child process so the real CLI, with the real endpoint URLs, reaches a fake
// server on 127.0.0.1 instead of a vendor. Every request to
// `https://api.anthropic.com` or `https://chatgpt.com` is sent to
// `LYKOS_TEST_FETCH_REDIRECT` with its path and headers unchanged; any other
// URL is refused, so a test can never reach the network. Imported by tests
// only; nothing in a session loads it.

const target = process.env.LYKOS_TEST_FETCH_REDIRECT;
if (target === undefined || target.length === 0) {
  throw new Error("redirect-fetch-preload: LYKOS_TEST_FETCH_REDIRECT is not set");
}

const REDIRECTED = new Set(["https://api.anthropic.com", "https://chatgpt.com"]);
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!REDIRECTED.has(url.origin)) throw new Error(`redirect-fetch-preload: refused ${url.origin}`);
  return realFetch(`${target}${url.pathname}${url.search}`, init);
}) as typeof globalThis.fetch;
