import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical deterministic JSON serializer with recursively sorted keys. */
export function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return "{" + entries.join(",") + "}";
}

/** First 16 hex characters of SHA-256 of public key PEM. */
export function computeKeyId(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem.trim()).digest("hex").slice(0, 16);
}

/** Generates Ed25519 key pair with PEM representations and key_id. */
export function generateEd25519KeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyId = computeKeyId(publicKeyPem);
  return { publicKeyPem, privateKeyPem, keyId };
}

/** Signs canonical JSON (excluding signature field) with private key. Returns hex string. */
export function signPayload(payload: Record<string, unknown>, privateKeyPem: string): string {
  const { signature: _sig, ...rest } = payload;
  const canonical = canonicalJson(rest);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKeyPem);
  return sig.toString("hex");
}

/** Verifies canonical JSON (excluding signature field) against public key. */
export function verifySignature(
  payload: Record<string, unknown>,
  signatureHex: string,
  publicKeyPem: string,
): boolean {
  try {
    const { signature: _sig, ...rest } = payload;
    const canonical = canonicalJson(rest);
    return crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKeyPem,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

export function getSealKeysDir(customHome?: string): string {
  return join(customHome ?? homedir(), ".lykos", "seal-keys");
}

export function savePrivateKey(keyId: string, privateKeyPem: string, customHome?: string): string {
  const dir = getSealKeysDir(customHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, `${keyId}.pem`);
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  return keyPath;
}

export function loadPrivateKey(keyId: string, customHome?: string): string | null {
  const keyPath = join(getSealKeysDir(customHome), `${keyId}.pem`);
  if (!existsSync(keyPath)) return null;
  return readFileSync(keyPath, "utf8");
}

/** Lists all available private keys in ~/.lykos/seal-keys/ */
export function listPrivateKeys(customHome?: string): Array<{ keyId: string; privateKeyPem: string }> {
  const dir = getSealKeysDir(customHome);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".pem"));
  const keys: Array<{ keyId: string; privateKeyPem: string }> = [];
  for (const f of files) {
    const keyId = f.replace(/\.pem$/, "");
    const privateKeyPem = readFileSync(join(dir, f), "utf8");
    keys.push({ keyId, privateKeyPem });
  }
  return keys;
}
