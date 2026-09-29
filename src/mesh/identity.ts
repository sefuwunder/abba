// identity.ts — ed25519 node identity. Peer ID = first 32 hex chars of sha256(spki der).
import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  id: string;          // peer id, hex
  publicKey: string;   // base64 spki der
  privateKey: string;  // base64 pkcs8 der
}

export function peerIdFor(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 32);
}

export function loadOrCreateIdentity(dataDir: string): Identity {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, "identity.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j.id && j.publicKey && j.privateKey && peerIdFor(j.publicKey) === j.id) return j as Identity;
    } catch { /* regenerate below */ }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const idn: Identity = {
    id: peerIdFor(pubDer.toString("base64")),
    publicKey: pubDer.toString("base64"),
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
  };
  writeFileSync(p, JSON.stringify(idn, null, 2), { mode: 0o600 });
  return idn;
}

export function signData(idn: Identity, data: string): string {
  const key = createPrivateKey({ key: Buffer.from(idn.privateKey, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(data, "utf8"), key).toString("base64");
}

export function verifyData(publicKeyB64: string, data: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(data, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
