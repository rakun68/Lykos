// Which image a session's commands run in.
//
// Order: the configured image (a specialist's `containment.image`, else the
// project's: those layers have already merged into one value by the time it
// gets here), then `.devcontainer/devcontainer.json`, then the global config's
// image (a person's default for projects that say nothing), then the toolchain
// image Lykos ships. The devcontainer file is read directly, as
// JSON with comments; `@devcontainers/cli` is not a dependency, and only the
// two keys a Lykos session can honour are read: `image`, or `build.dockerfile`
// with `build.context`. A Dockerfile is built through the chosen runtime and
// tagged by what it was built from (the Dockerfile and the context path). It is built on every start and left to the runtime's layer cache, so a changed file the
// Dockerfile COPYs is picked up; see `alwaysBuild`.
//
// The devcontainer belongs to the workspace, and the workspace is not trusted
// (ADR-0036): a Dockerfile or context that resolves outside it is refused
// rather than handed to the runtime.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEVCONTAINER_PATH = join(".devcontainer", "devcontainer.json");

/** The image to run, and the Dockerfile to build it from when it is not simply pulled. */
export interface ResolvedImage {
  image: string;
  build?: { dockerfile: string; context: string };
  /**
   * Build on every start, relying on the runtime's layer cache. A devcontainer
   * Dockerfile may COPY files from its context, and a tag that hashes only the
   * Dockerfile would reuse a stale image after one of them changed. Asking the
   * runtime is exact (it honours COPY and .dockerignore) and cheap when
   * nothing changed; hashing the context here would reimplement both.
   */
  alwaysBuild?: boolean;
  /** Where the answer came from, for the progress line. */
  source: "config" | "devcontainer image" | "devcontainer build" | "default";
}

/** A devcontainer.json (or the Dockerfile it names) that cannot be used. The message says which and why. */
export class ImageResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageResolutionError";
  }
}

/** JSON with `//` and block comments and trailing commas, as devcontainer.json is written. Strings are left alone. */
export function parseJsonWithComments(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      out += " ";
    } else {
      out += ch;
    }
  }
  // A comma that only whitespace separates from a closing bracket goes too.
  return JSON.parse(removeTrailingCommas(out));
}

function removeTrailingCommas(json: string): string {
  let out = "";
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j;
    } else if (ch === ",") {
      const next = /\S/.exec(json.slice(i + 1));
      const following = next === null ? undefined : json[i + 1 + next.index];
      if (following !== "}" && following !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `lykos/devcontainer:<12 hex>`: the Dockerfile's bytes and the context it is built against, on this machine. */
export function devcontainerImageTag(dockerfile: string, context: string): string {
  const hash = createHash("sha256").update(readFileSync(dockerfile)).update("\0").update(context).digest("hex").slice(0, 12);
  return `lykos/devcontainer:${hash}`;
}

function readDevcontainer(workspace: string): { file: string; json: Record<string, unknown> } | undefined {
  const file = join(workspace, DEVCONTAINER_PATH);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonWithComments(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ImageResolutionError(`lykos: ${file} is not valid JSON with comments: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ImageResolutionError(`lykos: ${file} must contain a JSON object`);
  }
  return { file, json: parsed as Record<string, unknown> };
}

/**
 * The image for a session whose workspace is `workspace`. `configured` is the
 * merged `containment.image` ("" when no layer set one); `defaultImage` is the
 * toolchain image, with the Dockerfile it is built from.
 */
export function resolveImage(input: {
  configured: string | undefined;
  /** The global config's `containment.image`: below the project's devcontainer. */
  globalImage?: string | undefined;
  workspace: string;
  defaultImage: { tag: string; dockerfile: string };
}): ResolvedImage {
  if (input.configured !== undefined && input.configured !== "") return { image: input.configured, source: "config" };

  const devcontainer = readDevcontainer(input.workspace);
  const fromDevcontainer = devcontainer === undefined ? undefined : imageOfDevcontainer(devcontainer, input.workspace);
  if (fromDevcontainer !== undefined) return fromDevcontainer;

  if (input.globalImage !== undefined && input.globalImage !== "") return { image: input.globalImage, source: "config" };

  return {
    image: input.defaultImage.tag,
    build: { dockerfile: input.defaultImage.dockerfile, context: dirname(input.defaultImage.dockerfile) },
    source: "default",
  };
}

function imageOfDevcontainer({ file, json }: { file: string; json: Record<string, unknown> }, workspace: string): ResolvedImage | undefined {
  if (json.image !== undefined) {
    if (typeof json.image !== "string" || json.image.trim() === "") throw new ImageResolutionError(`lykos: ${file}: "image" must be a non-empty string`);
    return { image: json.image, source: "devcontainer image" };
  }
  const build = json.build;
  if (build === undefined) return undefined;
  if (typeof build !== "object" || build === null || Array.isArray(build)) throw new ImageResolutionError(`lykos: ${file}: "build" must be an object`);
  const { dockerfile, context } = build as Record<string, unknown>;
  if (dockerfile === undefined) return undefined;
  if (typeof dockerfile !== "string" || dockerfile === "") throw new ImageResolutionError(`lykos: ${file}: "build.dockerfile" must be a non-empty string`);
  if (context !== undefined && typeof context !== "string") throw new ImageResolutionError(`lykos: ${file}: "build.context" must be a string`);

  // Both are relative to the directory the devcontainer.json is in.
  const base = dirname(file);
  const dockerfilePath = resolve(base, dockerfile);
  const contextPath = resolve(base, context ?? ".");
  const root = realpathSync(workspace);
  const outside = (path: string, what: string): ImageResolutionError =>
    new ImageResolutionError(`lykos: ${file}: ${what} ${path} is outside the workspace; a devcontainer may only build from files in its project`);
  const real = (path: string, what: string): string => {
    if (!isInside(resolve(workspace), path) && !isInside(root, path)) throw outside(path, what);
    if (!existsSync(path)) throw new ImageResolutionError(`lykos: ${file}: ${what} ${path} does not exist`);
    const resolved = realpathSync(path);
    // A symlink inside the workspace to somewhere outside it is outside it.
    if (!isInside(root, resolved)) throw outside(path, what);
    return resolved;
  };
  const realDockerfile = real(dockerfilePath, "build.dockerfile");
  const realContext = real(contextPath, "build.context");
  return {
    image: devcontainerImageTag(realDockerfile, realContext),
    build: { dockerfile: realDockerfile, context: realContext },
    alwaysBuild: true,
    source: "devcontainer build",
  };
}
