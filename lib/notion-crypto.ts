import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

type TokenPurpose = "access" | "refresh";

const VERSION = "v1";
const MAX_TOKEN_BYTES = 8192;

function encryptionKey() {
  const value = process.env.HUSH_TOKEN_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("HUSH token encryption key is missing or invalid.");
  }
  return Buffer.from(value, "hex");
}

function associatedData(workspaceId: string, purpose: TokenPurpose) {
  const normalized = workspaceId.replace(/-/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new Error("A valid workspace ID is required.");
  }
  if (purpose !== "access" && purpose !== "refresh") {
    throw new Error("A valid token purpose is required.");
  }
  return Buffer.from(`hush:notion:${VERSION}:${normalized}:${purpose}`, "utf8");
}

export function encryptNotionToken(
  token: string,
  workspaceId: string,
  purpose: TokenPurpose = "access"
): string {
  if (typeof token !== "string" || !token.trim() || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new Error("A valid Notion token is required.");
  }

  const key = encryptionKey();
  const aad = associatedData(workspaceId, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptNotionToken(
  encryptedToken: string,
  workspaceId: string,
  purpose: TokenPurpose = "access"
): string {
  const key = encryptionKey();
  const aad = associatedData(workspaceId, purpose);

  try {
    if (typeof encryptedToken !== "string" || encryptedToken.length > 12000) {
      throw new Error("Invalid encrypted token.");
    }

    const parts = encryptedToken.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION ||
        parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new Error("Invalid encrypted token.");
    }

    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");

    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > MAX_TOKEN_BYTES) {
      throw new Error("Invalid encrypted token.");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("The Notion connection could not be decrypted.");
  }
}
