// P5 #39: `tui.keybinds` per action, with the layer that set each. `mergeSection` merges `tui` one level deep, so a
// project layer naming one action would drop the global layer's others: the layers are read here instead.

import { layerLabel } from "./roles.js";
import type { ConfigLayer, TuiKeybindValue } from "./types.js";

export interface KeybindSetting {
  value: TuiKeybindValue;
  /** `global`, `project`, `env` or `flags`, with its file when it has one. */
  source: string;
}

/** #58 item 9: each colour role a layer sets, from the last layer that names it, with that layer. */
export function tuiColors(layers: readonly ConfigLayer[]): Record<string, { value: string; source: string }> {
  const out: Record<string, { value: string; source: string }> = {};
  for (const layer of layers) {
    if (!layer.present || layer.name === "defaults" || layer.name === "specialist") continue;
    const colors = layer.value.tui?.colors;
    if (colors === undefined || colors === null) continue;
    for (const [name, value] of Object.entries(colors)) out[name] = { value, source: layerLabel(layer) };
  }
  return out;
}

/** Each action a layer binds, from the last layer that names it. Actions no layer names are absent: the defaults. */
export function tuiKeybinds(layers: readonly ConfigLayer[]): Record<string, KeybindSetting> {
  const out: Record<string, KeybindSetting> = {};
  for (const layer of layers) {
    if (!layer.present || layer.name === "defaults" || layer.name === "specialist") continue;
    const binds = layer.value.tui?.keybinds;
    if (binds === undefined || binds === null) continue;
    for (const [name, value] of Object.entries(binds)) out[name] = { value, source: layerLabel(layer) };
  }
  return out;
}
