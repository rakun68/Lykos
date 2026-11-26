// Tests build a flat `PiContext`; Pi 1.6.1 stream functions take a `TranscriptContext`.
// This wraps a stream function so a test passes the flat form and Pi normalizes it.

import { normalizeContext } from "@earendil-works/pi-ai";
import type { PiContext, PiModel, PiSimpleStreamOptions, StreamSimpleFn } from "./google-cca/types.js";

export function plainContext(fn: StreamSimpleFn): (model: PiModel, context: PiContext, options?: PiSimpleStreamOptions) => ReturnType<StreamSimpleFn> {
  return (model, context, options) => fn(model, normalizeContext(context), options);
}
