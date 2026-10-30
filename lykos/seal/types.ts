export type SealAdapter = "node:test" | "vitest" | "exit";

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
