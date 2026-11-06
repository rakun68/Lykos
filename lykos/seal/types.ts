export type SealAdapter = "node:test" | "vitest" | "cargo" | "exit";

export interface SealRedTest {
  file: string;
  describe: string[];
  name: string;
  failure: "assertion";
}

export interface SealFile {
  version: 1;
  branch: string;
  base?: string | undefined;
  writer_commit: string;
  creator: string;
  specialist: string | null;
  sealed_paths: string[];
  test_command: string;
  adapter: SealAdapter;
  red: SealRedTest[];
  /** T254: `skipped` when the task said `red: false`: no red check ran, and the seal says so. */
  red_check?: "skipped" | undefined;
  /** Exit-code mode only: the red run's exit code and the hash of its normalised output (T251). */
  red_signature?: { exit: number | null; hash: string } | undefined;
  created_at: string;
  key_id: string;
  signature?: string | undefined;
}

export type SealVerdict = "valid" | "tampered" | "untrusted_key" | "stale";

export interface SealStatus {
  branch: string;
  verdict: SealVerdict;
  sealCommit: string;
  writerCommit: string;
  keyId: string;
  sealedPaths: string[];
  red: SealRedTest[];
  reason?: string | undefined;
}
