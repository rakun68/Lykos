import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOpenableUrl, openUrl } from "./open-url.js";

// `openUrl()` itself shells out to a real platform command (`start`/`open`/
// `xdg-open`) and is not exercised here for the same reason `clipboard.ts`'s
// `readClipboard()` has no test file either — actually launching a browser
// is not something a test suite should do as a side effect. `isOpenableUrl`
// is the part worth pinning: it is the actual security boundary (2026-09-02
// round nine, item 2's own module doc — never let untrusted text reach a
// shell-out unchecked), and `openUrl` itself is verified to route through it
// below without ever reaching a real spawn for a refused URL.

describe("isOpenableUrl: only http(s) is ever considered openable", () => {
  it("accepts http and https", () => {
    assert.equal(isOpenableUrl("https://example.com/docs"), true);
    assert.equal(isOpenableUrl("http://example.com"), true);
  });

  it("refuses every other scheme — javascript:, file:, custom protocol handlers", () => {
    assert.equal(isOpenableUrl("javascript:alert(1)"), false);
    assert.equal(isOpenableUrl("file:///etc/passwd"), false);
    assert.equal(isOpenableUrl("vscode://file/x"), false);
    assert.equal(isOpenableUrl("data:text/html,<script>1</script>"), false);
  });

  it("refuses garbage that is not a URL at all, rather than throwing", () => {
    assert.equal(isOpenableUrl("not a url"), false);
    assert.equal(isOpenableUrl(""), false);
    assert.equal(isOpenableUrl("; rm -rf ~"), false);
  });
});

describe("openUrl: a refused URL never reaches a shell-out", () => {
  it("returns false immediately for a non-http(s) URL, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      assert.equal(openUrl("javascript:alert(1)", platform), false);
    }
  });
});
