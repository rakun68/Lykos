// Opening a link in the system's default browser — 2026-09-02 round nine,
// item 2: "the link is hoverable but clicking, nothing happens, add
// hyperlink too." `markdown.ts` renders a link as a styled label plus a
// `[n]` index rather than an OSC 8 terminal hyperlink (see that file's own
// module doc for why — width-measurement risk, mainly), which means
// Lykos itself has to be the thing that opens the URL once a click on
// `[n]` resolves to one.
//
// Same shape as `clipboard.ts`'s `readClipboard()`: one platform command
// per OS, `spawnSync` with an ARGV ARRAY (never a shell string), so the
// URL can never be interpreted as shell syntax no matter what a model
// puts in a markdown link — this is the one place in this file's whole
// click-handling round where untrusted text (the URL) reaches a child
// process, and it is treated accordingly.

import { spawnSync } from "node:child_process";

/** Refuses anything that isn't a plain `http`/`https` URL — a `javascript:`, `file:`, or custom-scheme link never reaches a shell-out, regardless of what opening it would even do on the host. */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface OpenCommand {
  cmd: string;
  args: string[];
}

function openCommand(url: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === "win32") {
    // `start` is a cmd.exe built-in, not its own executable — the empty
    // "" is the window-title argument `start` requires before a URL that
    // could otherwise be mistaken for one.
    return { cmd: "cmd", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Best-effort, fire-and-forget: returns whether the command was even
 * launched, never whether a browser actually opened (there is no portable
 * way to know that). A non-http(s) URL or a missing platform binary both
 * return `false` rather than throwing — the caller's job is to tell the
 * user, not to crash the session over a dead link.
 */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isOpenableUrl(url)) return false;
  const { cmd, args } = openCommand(url, platform);
  try {
    const res = spawnSync(cmd, args, { timeout: 3000, windowsHide: true, stdio: "ignore" });
    return !res.error;
  } catch {
    return false;
  }
}
