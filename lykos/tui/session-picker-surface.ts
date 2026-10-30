import { stdoutWrite } from "./io-mode.js";
import { decideRenderMode } from "./screen/fallback.js";
import { FrameWriter, makeFrame } from "./screen/frame.js";
import { KeyDecoder, type KeyEvent } from "./screen/input.js";
import { ScreenTerminal } from "./screen/terminal.js";
import { vtSupport } from "./screen/vt.js";

export type { KeyEvent };

export interface SessionPickerIo {
  size(): { columns: number; rows: number };
  paint(lines: readonly string[]): void;
  nextKey(): Promise<KeyEvent | null>;
  close(): void;
}

export async function createSessionPickerIo(): Promise<SessionPickerIo> {
  const terminal = new ScreenTerminal({});
  terminal.enter();
  const writer = new FrameWriter({ write: (text) => stdoutWrite(text) });
  const decoder = new KeyDecoder();
  const queue: KeyEvent[] = [];
  let waiting: ((key: KeyEvent | null) => void) | null = null;
  const onData = (chunk: Buffer | string): void => {
    for (const key of decoder.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"))) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(key);
      } else queue.push(key);
    }
  };
  process.stdin.on("data", onData);
  process.stdin.resume();

  return {
    size: () => terminal.size(),
    paint: (lines) => {
      const size = terminal.size();
      writer.write(makeFrame(size.columns, size.rows, lines));
    },
    nextKey: () =>
      new Promise<KeyEvent | null>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiting = resolve;
      }),
    close: () => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      terminal.leave();
    },
  };
}

export async function sessionPickerIsFullscreen(opts: {
  noFullscreen?: boolean;
}): Promise<boolean> {
  const vt = await vtSupport();
  return decideRenderMode({
    ioMode: (await import("./io-mode.js")).getIoMode(),
    isTTY: Boolean(process.stdout.isTTY),
    vtSupported: vt.supported,
    noFullscreen: opts.noFullscreen === true,
    term: process.env.TERM,
  }).mode === "fullscreen";
}
