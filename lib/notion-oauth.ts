import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type OAuthState = {
  nonce: string;
  userId: string;
  workspaceId: string;
  expiresAt: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OAUTH_COOKIE = "hush_notion_oauth";

export function notionOAuthCredentials() {
  const clientId = process.env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET;
  if (!clientId || !UUID.test(clientId) || !clientSecret) {
    throw new Error("Notion OAuth credentials are missing or invalid.");
  }
  return { clientId, clientSecret };
}

export function notionOAuthConfig() {
  const credentials = notionOAuthCredentials();
  const redirectUri = process.env.NOTION_OAUTH_REDIRECT_URI;
  if (!redirectUri) throw new Error("The Notion OAuth redirect address is missing.");
  const url = new URL(redirectUri);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/api/notion/oauth/callback" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:" && process.env.NODE_ENV === "development"))
  ) {
    throw new Error("The Notion OAuth redirect address is invalid.");
  }
  return { ...credentials, redirectUri, origin: url.origin, secure: url.protocol === "https:" };
}

function signature(payload: string) {
  const key = process.env.HUSH_TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error("OAuth signing settings are missing.");
  const config = notionOAuthConfig();
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`hush:notion:oauth-state:v1:${config.clientId}:${config.redirectUri}:`)
    .update(payload).digest();
}

export function createNotionOAuthState(userId: string, workspaceId: string) {
  if (!UUID.test(userId) || !UUID.test(workspaceId)) throw new Error("Invalid OAuth account or workspace.");
  const value: OAuthState = {
    nonce: randomBytes(32).toString("base64url"),
    userId: userId.toLowerCase(), workspaceId: workspaceId.toLowerCase(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return { state: value.nonce, cookie: `${payload}.${signature(payload).toString("base64url")}` };
}

export function verifyNotionOAuthState(cookie: string, returnedState: string): OAuthState {
  if (cookie.length > 2000 || !/^[A-Za-z0-9_-]{43}$/.test(returnedState)) throw new Error("Invalid OAuth state.");
  const parts = cookie.split(".");
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid OAuth state.");
  const expected = signature(parts[0]);
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid OAuth state.");
  const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as OAuthState;
  if (
    typeof value.userId !== "string" || !UUID.test(value.userId) ||
    typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId) ||
    typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) ||
    !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 10 * 60 * 1000 ||
    !timingSafeEqual(Buffer.from(value.nonce), Buffer.from(returnedState))
  ) throw new Error("OAuth state is invalid or expired.");
  return value;
}

export const OAUTH_PENDING_COOKIE = "hush_notion_pending";
export type PendingNotionGrant = {
  userId: string;
  workspaceId: string;
  accessToken: string;
  refreshToken: string | null;
  notionWorkspaceId: string | null;
  notionWorkspaceName: string | null;
  tokenExpiresAt: string | null;
  expiresAt: number;
};

function pendingKey() {
  const key = process.env.HUSH_TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error("OAuth encryption settings are missing.");
  return Buffer.from(key, "hex");
}
function pendingAAD() {
  const config = notionOAuthConfig();
  return Buffer.from(`hush:notion:oauth-pending:v1:${config.clientId}:${config.redirectUri}`);
}
export function sealPendingNotionGrant(grant: PendingNotionGrant) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pendingKey(), iv);
  cipher.setAAD(pendingAAD());
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
  const cookie = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
  if (cookie.length > 3700) throw new Error("The OAuth grant is too large for temporary storage.");
  return cookie;
}
export function openPendingNotionGrant(cookie: string): PendingNotionGrant {
  if (cookie.length > 3700) throw new Error("Invalid temporary OAuth grant.");
  const parts = cookie.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid temporary OAuth grant.");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid temporary OAuth grant.");
  const decipher = createDecipheriv("aes-256-gcm", pendingKey(), iv);
  decipher.setAAD(pendingAAD());
  decipher.setAuthTag(tag);
  const grant = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as PendingNotionGrant;
  if (
    !grant || typeof grant.userId !== "string" || !UUID.test(grant.userId) ||
    typeof grant.workspaceId !== "string" || !UUID.test(grant.workspaceId) ||
    typeof grant.accessToken !== "string" || !grant.accessToken ||
    (grant.refreshToken !== null && typeof grant.refreshToken !== "string") ||
    (grant.notionWorkspaceId !== null && (typeof grant.notionWorkspaceId !== "string" || !UUID.test(grant.notionWorkspaceId))) ||
    (grant.notionWorkspaceName !== null && typeof grant.notionWorkspaceName !== "string") ||
    (grant.tokenExpiresAt !== null && (typeof grant.tokenExpiresAt !== "string" || !Number.isFinite(Date.parse(grant.tokenExpiresAt)))) ||
    !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 10 * 60 * 1000
  ) throw new Error("The temporary OAuth grant is invalid or expired.");
  return grant;
}
