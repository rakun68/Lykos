// GitLab Duo Agent runtime namespace discovery.
//
// The runtime namespace comes from, in order: the namespace override, the
// configured project, the workspace git remote, then the top-level groups.
//
// Read-only (plan D4): the git remote is read from `.git/config` (following a `.git` file's
// `gitdir:` and a linked worktree's `commondir`) with `fs.readFile`. No
// process is spawned and nothing is written. Every GitLab call is a GET or a GraphQL query.
//
// Left out: model discovery (`fetchGitLabDuoWorkflowModels`, `validateNamespaceCandidate`);
// Lykos's models come from the generated provider table (plan D5).
//
// Each fetch here carries the stream's per-fetch REST deadline, so a stalled lookup cannot
// leave the stream with no terminal event.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

// discovery/gitlab-duo-workflow.ts constants.
const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";
const GRAPHQL_PATH = "/api/graphql";
const PROJECTS_PATH = "/api/v4/projects";
const GROUPS_PATH = "/api/v4/groups";
const GITLAB_DUO_WORKFLOW_MAX_GROUP_PAGES = 50;

const ProjectRootNamespaceQuery = `query lykos_gitlabDuoWorkflowProjectRootNamespace($fullPath: ID!) {
  project(fullPath: $fullPath) {
    namespace {
      id
      rootAncestor { id }
    }
  }
}`;

export type GitLabDuoWorkflowCandidateSource = "override" | "project" | "remote" | "group";

export interface GitLabDuoWorkflowNamespaceSelection {
  rootNamespaceId: string;
  namespacePath?: string;
  /** The project (full path) the namespace was resolved from, when known. */
  projectPath?: string;
  source: GitLabDuoWorkflowCandidateSource;
}

export interface GitLabDuoWorkflowDiscoveryConfig {
  apiKey: string;
  baseUrl?: string;
  fetch: typeof fetch;
  namespaceId?: string;
  projectId?: string;
  cwd?: string;
  /** A fresh per-fetch abort signal (the stream's REST deadline). */
  signal?: () => AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): Record<string, unknown> | null {
  const target = key ? (isRecord(value) ? value[key] : undefined) : value;
  return isRecord(target) ? target : null;
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeGitLabBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() || GITLAB_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "") || GITLAB_DEFAULT_BASE_URL;
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function requestInit(config: GitLabDuoWorkflowDiscoveryConfig, init: RequestInit): RequestInit {
  return config.signal ? { ...init, signal: config.signal() } : init;
}

async function getJson(config: GitLabDuoWorkflowDiscoveryConfig, url: string): Promise<{ ok: boolean; response?: Response; payload?: unknown }> {
  let response: Response;
  try {
    response = await config.fetch(url, requestInit(config, { method: "GET", headers: jsonHeaders(config.apiKey) }));
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false, response };
  try {
    return { ok: true, response, payload: await response.json() };
  } catch {
    return { ok: false, response };
  }
}

async function postGraphQL(
  config: GitLabDuoWorkflowDiscoveryConfig,
  baseUrl: string,
  query: string,
  variables: Record<string, string>,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await config.fetch(
      `${baseUrl}${GRAPHQL_PATH}`,
      requestInit(config, { method: "POST", headers: jsonHeaders(config.apiKey), body: JSON.stringify({ query, variables }) }),
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** discoverGitLabDuoWorkflowRuntimeNamespace: the first candidate that resolves, else the source's error text. */
export async function discoverGitLabDuoWorkflowRuntimeNamespace(
  config: GitLabDuoWorkflowDiscoveryConfig,
): Promise<GitLabDuoWorkflowNamespaceSelection> {
  const baseUrl = normalizeGitLabBaseUrl(config.baseUrl);

  const namespaceId = normalizeIdentifier(config.namespaceId);
  if (namespaceId) {
    const candidate = (await fetchNamespaceOverrideCandidate(config, baseUrl, namespaceId)) ?? {
      rootNamespaceId: namespaceId,
      source: "override" as const,
    };
    const selected = resolveRuntimeNamespaceCandidate(candidate);
    if (selected) return selected;
  }

  const projectId = normalizeIdentifier(config.projectId);
  if (projectId) {
    const projectNamespace = await fetchProjectRootNamespace(config, baseUrl, projectId);
    if (projectNamespace) {
      const selected = resolveRuntimeNamespaceCandidate({
        rootNamespaceId: projectNamespace,
        ...(projectId.includes("/") ? { projectPath: projectId } : {}),
        source: "project",
      });
      if (selected) return selected;
    }
  }

  const remoteProjectPath = await discoverGitLabRemoteProjectPath(config.cwd, baseUrl);
  if (remoteProjectPath) {
    const remoteNamespace = await fetchProjectRootNamespace(config, baseUrl, remoteProjectPath);
    if (remoteNamespace) {
      const selected = resolveRuntimeNamespaceCandidate({
        rootNamespaceId: remoteNamespace,
        projectPath: remoteProjectPath,
        source: "remote",
      });
      if (selected) return selected;
    }
  }

  for (const groupNamespace of await fetchTopLevelGroupNamespaceCandidates(config, baseUrl)) {
    const selected = resolveRuntimeNamespaceCandidate(groupNamespace);
    if (selected) return selected;
  }

  throw new Error(
    "Unable to find a GitLab Duo Workflow namespace. Set GITLAB_DUO_NAMESPACE_ID to a root namespace or GITLAB_DUO_PROJECT_ID to a GitLab project.",
  );
}

function resolveRuntimeNamespaceCandidate(candidate: GitLabDuoWorkflowNamespaceSelection): GitLabDuoWorkflowNamespaceSelection | null {
  const rootNamespaceId = normalizeIdentifier(candidate.rootNamespaceId);
  const namespacePath = normalizeIdentifier(candidate.namespacePath);
  const projectPath = normalizeIdentifier(candidate.projectPath);
  return rootNamespaceId
    ? {
        rootNamespaceId,
        ...(namespacePath ? { namespacePath } : {}),
        ...(projectPath ? { projectPath } : {}),
        source: candidate.source,
      }
    : null;
}

function toRestNamespaceId(namespaceId: string): string | null {
  const gidMatch = namespaceId.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/);
  if (gidMatch?.[1]) return gidMatch[1];
  return /^\d+$/.test(namespaceId) ? namespaceId : null;
}

async function fetchNamespaceOverrideCandidate(
  config: GitLabDuoWorkflowDiscoveryConfig,
  baseUrl: string,
  namespaceId: string,
): Promise<GitLabDuoWorkflowNamespaceSelection | null> {
  const restNamespaceId = toRestNamespaceId(namespaceId);
  if (!restNamespaceId) return null;
  const { ok, payload } = await getJson(config, `${baseUrl}${GROUPS_PATH}/${encodeURIComponent(restNamespaceId)}`);
  if (!ok) return null;
  const rootNamespaceId = extractRootNamespaceId(payload) ?? namespaceId;
  const namespacePath = extractNamespacePath(payload);
  return { rootNamespaceId, ...(namespacePath ? { namespacePath } : {}), source: "override" };
}

async function fetchProjectRootNamespace(
  config: GitLabDuoWorkflowDiscoveryConfig,
  baseUrl: string,
  projectIdOrPath: string,
): Promise<string | null> {
  const { ok, payload } = await getJson(config, `${baseUrl}${PROJECTS_PATH}/${encodeURIComponent(projectIdOrPath)}`);
  const rest = ok ? { rootNamespaceId: extractExplicitRootNamespaceId(payload), pathWithNamespace: extractProjectFullPath(payload) } : null;
  if (rest?.rootNamespaceId) return rest.rootNamespaceId;
  const fullPath = rest?.pathWithNamespace ?? (projectIdOrPath.includes("/") ? projectIdOrPath : null);
  if (!fullPath) return null;
  const graph = await postGraphQL(config, baseUrl, ProjectRootNamespaceQuery, { fullPath });
  if (!graph) return null;
  return extractExplicitRootNamespaceId(getRecord(getRecord(graph, "data"), "project"));
}

async function fetchTopLevelGroupNamespaceCandidates(
  config: GitLabDuoWorkflowDiscoveryConfig,
  baseUrl: string,
): Promise<GitLabDuoWorkflowNamespaceSelection[]> {
  const candidates: (GitLabDuoWorkflowNamespaceSelection & { preferred: boolean })[] = [];
  let nextPage: string | undefined = "1";
  for (let page = 0; page < GITLAB_DUO_WORKFLOW_MAX_GROUP_PAGES && nextPage; page++) {
    const url = new URL(`${baseUrl}${GROUPS_PATH}`);
    url.searchParams.set("top_level_only", "true");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("order_by", "name");
    url.searchParams.set("sort", "asc");
    url.searchParams.set("page", nextPage);
    const { ok, response, payload } = await getJson(config, url.toString());
    if (!ok || !Array.isArray(payload)) break;
    for (const group of payload) {
      const rootNamespaceId = extractRootNamespaceId(group);
      if (!rootNamespaceId) continue;
      const namespacePath = extractNamespacePath(group);
      candidates.push({
        rootNamespaceId,
        ...(namespacePath ? { namespacePath } : {}),
        source: "group",
        preferred: hasDuoFeatureFlag(group),
      });
    }
    const header = response?.headers.get("x-next-page");
    nextPage = header && header.trim().length > 0 ? header.trim() : undefined;
  }
  candidates.sort((left, right) => Number(right.preferred) - Number(left.preferred));
  return candidates.map((c) => ({
    rootNamespaceId: c.rootNamespaceId,
    ...(c.namespacePath ? { namespacePath: c.namespacePath } : {}),
    source: c.source,
  }));
}

function extractExplicitRootNamespaceId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = normalizeIdentifier(value.root_namespace_id) ?? normalizeIdentifier(value.rootNamespaceId);
  if (direct) return direct;
  const rootNamespace =
    getRecord(value.root_namespace, "") ??
    getRecord(value.rootNamespace, "") ??
    getRecord(value.root_ancestor, "") ??
    getRecord(value.rootAncestor, "");
  if (rootNamespace) {
    return (
      normalizeIdentifier(rootNamespace.id) ??
      normalizeIdentifier(rootNamespace.full_path) ??
      normalizeIdentifier(rootNamespace.fullPath)
    );
  }
  const namespace = getRecord(value.namespace, "");
  return namespace ? extractExplicitRootNamespaceId(namespace) : null;
}

function extractRootNamespaceId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = normalizeIdentifier(value.root_namespace_id) ?? normalizeIdentifier(value.rootNamespaceId);
  if (direct) return direct;
  const rootNamespace =
    getRecord(value.root_namespace, "") ??
    getRecord(value.rootNamespace, "") ??
    getRecord(value.root_ancestor, "") ??
    getRecord(value.rootAncestor, "");
  const nestedRoot = rootNamespace
    ? (normalizeIdentifier(rootNamespace.id) ??
      normalizeIdentifier(rootNamespace.full_path) ??
      normalizeIdentifier(rootNamespace.fullPath))
    : null;
  if (nestedRoot) return nestedRoot;
  const namespace = getRecord(value.namespace, "");
  if (namespace) {
    return (
      extractRootNamespaceId(namespace) ??
      normalizeIdentifier(namespace.id) ??
      normalizeIdentifier(namespace.full_path) ??
      normalizeIdentifier(namespace.fullPath)
    );
  }
  return normalizeIdentifier(value.id) ?? normalizeIdentifier(value.full_path) ?? normalizeIdentifier(value.fullPath);
}

function extractNamespacePath(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return normalizeIdentifier(value.full_path) ?? normalizeIdentifier(value.fullPath) ?? normalizeIdentifier(value.path);
}

function extractProjectFullPath(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return normalizeIdentifier(value.path_with_namespace) ?? normalizeIdentifier(value.fullPath);
}

function hasDuoFeatureFlag(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.duo_features_enabled === true || value.duo_core_features_enabled === true;
}

// ---------------------------------------------------------------------------
// The workspace git remote, read from files only (plan D4).
// ---------------------------------------------------------------------------

export async function discoverGitLabRemoteProjectPath(cwd: string | undefined, baseUrl: string): Promise<string | null> {
  const gitConfigText = await readGitConfigText(cwd ?? process.cwd());
  if (!gitConfigText) return null;
  const remoteUrls = parseGitRemoteUrls(gitConfigText);
  const baseHost = parseUrlHost(baseUrl);
  const basePath = parseUrlBasePath(baseUrl);
  for (const remoteUrl of remoteUrls) {
    const projectPath = parseGitLabRemoteProjectPath(remoteUrl, baseHost, basePath);
    if (projectPath) return projectPath;
  }
  return null;
}

async function readGitConfigText(startCwd: string): Promise<string | null> {
  let current = resolve(startCwd);
  while (true) {
    const configText = await readGitConfigFromDotGit(join(current, ".git"));
    if (configText) return configText;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readGitConfigFromDotGit(gitPath: string): Promise<string | null> {
  const directConfig = await readTextFile(join(gitPath, "config"));
  if (directConfig !== null) return directConfig;
  const dotGitFile = await readTextFile(gitPath);
  if (dotGitFile === null) return null;
  const gitDir = parseGitDirFile(dotGitFile);
  if (!gitDir) return null;
  const gitDirPath = isAbsolute(gitDir) ? gitDir : resolve(dirname(gitPath), gitDir);
  const commonDir = await readTextFile(join(gitDirPath, "commondir"));
  if (commonDir) {
    const trimmed = commonDir.trim();
    const commonDirPath = isAbsolute(trimmed) ? trimmed : resolve(gitDirPath, trimmed);
    const commonConfig = await readTextFile(join(commonDirPath, "config"));
    if (commonConfig !== null) return commonConfig;
  }
  return readTextFile(join(gitDirPath, "config"));
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseGitDirFile(value: string): string | null {
  const match = value.match(/^gitdir:\s*(.+)$/im);
  return match?.[1]?.trim() || null;
}

function parseGitRemoteUrls(configText: string): string[] {
  const urls: string[] = [];
  let inRemoteSection = false;
  for (const line of configText.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inRemoteSection = /^remote\s+"[^"]+"$/.test((section[1] ?? "").trim());
      continue;
    }
    if (!inRemoteSection) continue;
    const match = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (match?.[1]) urls.push(match[1]);
  }
  return urls;
}

function parseGitLabRemoteProjectPath(remoteUrl: string, expectedHost: string | null, basePath: string): string | null {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) return null;
  if (expectedHost && !gitLabRemoteHostMatches(parsed.host, parsed.portInsensitive, expectedHost)) return null;
  let projectPath = parsed.projectPath.replace(/^\/+/, "");
  if (basePath && (projectPath === basePath || projectPath.startsWith(`${basePath}/`))) {
    projectPath = projectPath.slice(basePath.length);
  }
  projectPath = projectPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return projectPath.includes("/") ? projectPath : null;
}

function gitLabRemoteHostMatches(remoteHost: string, portInsensitive: boolean, expectedHost: string): boolean {
  if (!portInsensitive) return remoteHost.toLowerCase() === expectedHost.toLowerCase();
  const remoteHostname = remoteHost.split(":")[0] ?? remoteHost;
  const expectedHostname = expectedHost.split(":")[0] ?? expectedHost;
  return remoteHostname.toLowerCase() === expectedHostname.toLowerCase();
}

function parseRemoteUrl(remoteUrl: string): { host: string; projectPath: string; portInsensitive: boolean } | null {
  try {
    const url = new URL(remoteUrl);
    return { host: url.host, projectPath: url.pathname, portInsensitive: url.protocol === "ssh:" };
  } catch {
    const scpMatch = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (scpMatch?.[1] && scpMatch[2]) return { host: scpMatch[1], projectPath: scpMatch[2], portInsensitive: true };
    return null;
  }
}

function parseUrlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parseUrlBasePath(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
}
