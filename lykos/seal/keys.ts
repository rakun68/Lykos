import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateEd25519KeyPair, savePrivateKey } from "./crypto.js";
import { gitExec } from "./git.js";

export interface SealKeyInitResult {
  keyId: string;
  pubRelPath: string;
  privPath: string;
}

/** Initializes an Ed25519 key pair, commits the public key to the repo, and stores the private key in ~/.lykos/seal-keys/. */
export function sealKeyInit(
  cwd: string,
  homeDir?: string,
  env?: NodeJS.ProcessEnv,
): SealKeyInitResult {
  const { publicKeyPem, privateKeyPem, keyId } = generateEd25519KeyPair();
  const privPath = savePrivateKey(keyId, privateKeyPem, homeDir);

  const pubRelPath = `.lykos/seals/keys/${keyId}.pub`;
  const pubFullPath = join(cwd, pubRelPath);
  mkdirSync(dirname(pubFullPath), { recursive: true });
  writeFileSync(pubFullPath, publicKeyPem, "utf8");

  gitExec(["add", pubRelPath], cwd, env);
  gitExec(["commit", "-m", `seal: init key ${keyId}`, "--", pubRelPath], cwd, env);

  return { keyId, pubRelPath, privPath };
}
