// Boundary for the doctor's rendering benchmark. Pixel internals stay in the
// TUI even though the doctor command is a CLI adapter.
export { renderApp, type AppState } from "./screen/app.js";
export { FrameWriter } from "./screen/frame.js";
export { vtSupport, type VtProbeResult } from "./screen/vt.js";
