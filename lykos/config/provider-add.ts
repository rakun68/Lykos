// `/provider add`: a custom provider declared from a session, asked question by question, written into the
// `providers:` block of the global or the project `config.yaml`. The block is edited as lines, as `budget set` edits
// its own (`cli/budget.ts`), so the rest of the file keeps its layout and comments. The next session translates it
// into Pi's models.json (`providers.ts`), like a hand-written declaration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "yaml";

/** The API kinds offered for a custom provider: Pi's `KnownApi` values an endpoint of one's own speaks. */
export const CUSTOM_PROVIDER_APIS: readonly { value: string; label: string }[] = [
  { value: "openai-completions", label: "OpenAI Chat Completions (OpenRouter, Ollama, vLLM, LM Studio…)" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

export interface CustomProvider {
  id: string;
  api: string;
  baseUrl: string;
  models: string[];
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Why `id` cannot name a new provider, or undefined when it can. */
export function providerIdProblem(id: string, taken: readonly string[]): string | undefined {
  if (!ID.test(id)) return `"${id}" is not a provider name: lowercase letters, digits, ".", "_" and "-", starting with a letter or digit`;
  if (taken.includes(id)) return `a provider named "${id}" already exists`;
  return undefined;
}

/** Why `url` cannot be a base URL, or undefined when it can. */
export function baseUrlProblem(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return undefined;
  } catch {
    // Reported below.
  }
  return `"${url}" is not an http or https URL`;
}

/** The model ids in a typed list, split on commas and spaces. */
export function modelIds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((m) => m.length > 0))];
}

function block(p: CustomProvider): string[] {
  // A JSON string is a YAML double-quoted scalar, so a URL or an id with `:` or `#` stays one value.
  return [
    `  ${p.id}:`,
    "    auth: api_key",
    `    api: ${p.api}`,
    `    baseUrl: ${JSON.stringify(p.baseUrl)}`,
    // No models yet: the model picker asks the endpoint and adds the ones shown.
    ...(p.models.length === 0 ? ["    models: []"] : ["    models:", ...p.models.map((m) => `      - id: ${JSON.stringify(m)}`)]),
  ];
}

/**
 * `raw` with `model` added to the `models:` list of `provider`, declared in its block-style `providers:` block. Nothing
 * changes when the model is listed already.
 */
export function addModelToConfig(raw: string, provider: string, model: string): string {
  const parsed: unknown = raw.trim().length > 0 ? parse(raw) : undefined;
  const providers = typeof parsed === "object" && parsed !== null ? (parsed as { providers?: unknown }).providers : undefined;
  const decl = typeof providers === "object" && providers !== null ? (providers as Record<string, unknown>)[provider] : undefined;
  if (typeof decl !== "object" || decl === null) throw new Error(`${provider} is not declared in this file`);
  const listed = (decl as { models?: unknown }).models;
  if (Array.isArray(listed) && listed.some((m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === model)) return raw;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const top = lines.findIndex((l) => /^providers:\s*(#.*)?$/.test(l));
  const at = top === -1 ? -1 : lines.findIndex((l, i) => i > top && l.replace(/\s*(#.*)?$/, "") === `  ${provider}:`);
  if (at === -1) throw new Error(`${provider}'s declaration is not in block style; add the model by hand`);
  // The provider's block ends at the next line indented two spaces or less.
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && !/^ {3}/.test(l)) {
      end = i;
      break;
    }
  }
  const entry = `      - id: ${JSON.stringify(model)}`;
  const key = lines.findIndex((l, i) => i > at && i < end && /^    models:/.test(l));
  if (key === -1) {
    let last = at;
    for (let i = at + 1; i < end; i++) if (lines[i]!.trim() !== "") last = i;
    lines.splice(last + 1, 0, "    models:", entry);
  } else if (/^    models:\s*\[\s*\]\s*(#.*)?$/.test(lines[key]!)) {
    lines.splice(key, 1, "    models:", entry);
  } else if (/^    models:\s*(#.*)?$/.test(lines[key]!)) {
    let last = key;
    let dash: string | undefined;
    for (let i = key + 1; i < end; i++) {
      const l = lines[i]!;
      if (l.trim() === "") continue;
      if (!/^ {5}/.test(l) && !/^ {4}-/.test(l)) break;
      dash ??= /^( *)- /.exec(l)?.[1];
      last = i;
    }
    // The new item at the indent the list's items have, which YAML lets be four spaces or more.
    lines.splice(last + 1, 0, dash !== undefined ? `${dash}- id: ${JSON.stringify(model)}` : entry);
  } else {
    throw new Error(`${provider}'s models are not a block list; add the model by hand`);
  }
  return lines.join(eol);
}

/** Adds `model` to `provider`'s declared models in the config file at `path`. */
export function writeModelToConfig(path: string, provider: string, model: string): void {
  const raw = readFileSync(path, "utf8");
  const next = addModelToConfig(raw, provider, model);
  if (next !== raw) writeFileSync(path, next, "utf8");
}

/** `raw` with `p` declared at the end of its `providers:` block, which is added when there is none. */
export function addProviderToConfig(raw: string, p: CustomProvider): string {
  const parsed: unknown = raw.trim().length > 0 ? parse(raw) : undefined;
  const providers = typeof parsed === "object" && parsed !== null ? (parsed as { providers?: unknown }).providers : undefined;
  if (typeof providers === "object" && providers !== null && p.id in providers) {
    throw new Error(`a provider named "${p.id}" is already declared in this file`);
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => /^providers:\s*(\{\s*\})?\s*(#.*)?$/.test(l));
  if (start === -1) {
    if (lines.some((l) => /^providers:/.test(l))) throw new Error("its providers: block is not in block style; add the provider by hand");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 0) lines.push("");
    return [...lines, "providers:", ...block(p), ""].join(eol);
  }
  lines[start] = "providers:";
  // The block ends at the next top-level line; the provider goes after its last indented line.
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break;
    last = i;
  }
  lines.splice(last + 1, 0, ...block(p));
  return lines.join(eol);
}

/** Writes `p` into the config file at `path`, creating it when it does not exist. */
export function writeProviderToConfig(path: string, p: CustomProvider): void {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = addProviderToConfig(raw, p);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
}

export interface ProviderAddQuestion {
  title: string;
  detail: string;
  options?: readonly { value: string; label: string }[];
}

export interface ProviderAddIO {
  /** Asks one question; null when it was dismissed. */
  ask(q: ProviderAddQuestion): Promise<string | null>;
  say(line: string): void;
}

export interface ProviderAddTarget {
  globalPath: string;
  projectPath: string;
  /** Provider names already in use: the built-in ones and every declared one. */
  taken: readonly string[];
}

/** Asks for a custom provider and writes it; the provider and the file, or null when it was given up. */
export async function runProviderAdd(io: ProviderAddIO, target: ProviderAddTarget): Promise<{ provider: CustomProvider; path: string } | null> {
  const fail = (why: string): null => {
    io.say(`lykos: ${why}`);
    return null;
  };
  const id = (await io.ask({ title: "Provider name", detail: "A short name for the endpoint, used as provider/model (for example local or openrouter-eu)." }))?.trim();
  if (!id) return null;
  const idProblem = providerIdProblem(id, target.taken);
  if (idProblem) return fail(idProblem);

  const api = await io.ask({ title: "API", detail: `What ${id}'s endpoint speaks.`, options: CUSTOM_PROVIDER_APIS });
  if (!api) return null;
  if (!CUSTOM_PROVIDER_APIS.some((a) => a.value === api)) return fail(`"${api}" is not one of the API kinds offered`);

  const baseUrl = (await io.ask({ title: "Base URL", detail: "The endpoint's base URL, for example http://localhost:11434/v1." }))?.trim();
  if (!baseUrl) return null;
  const urlProblem = baseUrlProblem(baseUrl);
  if (urlProblem) return fail(urlProblem);

  const typed = await io.ask({ title: "Models", detail: "The model ids it serves, separated by commas or spaces." });
  if (typed === null) return null;
  const models = modelIds(typed);
  if (models.length === 0) return fail("a provider needs at least one model id");

  const scope = await io.ask({
    title: "Save to",
    detail: "Where the declaration is written.",
    options: [
      { value: "global", label: `Global: ${target.globalPath}` },
      { value: "project", label: `This project: ${target.projectPath}` },
    ],
  });
  if (scope !== "global" && scope !== "project") return null;

  const provider: CustomProvider = { id, api, baseUrl, models };
  const path = scope === "global" ? target.globalPath : target.projectPath;
  try {
    writeProviderToConfig(path, provider);
  } catch (e) {
    return fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { provider, path };
}
