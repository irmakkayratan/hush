import "server-only";
import { randomUUID } from "node:crypto";
import { decryptNotionToken, encryptNotionToken } from "./notion-crypto";
import { notionOAuthCredentials } from "./notion-oauth";
import { requireWorkspaceAccess, WorkspaceAccessError } from "./workspace-access";

type Access = Awaited<ReturnType<typeof requireWorkspaceAccess>>;
const reconnect = () => new WorkspaceAccessError("Ask your team administrator to reconnect Notion in Connect Notion.", 409);
const unavailable = () => new WorkspaceAccessError("Could not renew the Notion connection right now. Try again shortly.", 503);

export async function renewNotionAccess(access: Access, expected: string): Promise<string> {
  const attempt = randomUUID();
  const args = {
    p_workspace_id: access.workspaceId, p_user_id: access.user.id,
    p_expected_access: expected, p_attempt: attempt,
  };
  async function rotate(action: string, extra: Record<string, unknown> = {}) {
    const { data, error } = await access.admin.rpc("hush_rotate_notion_connection", { ...args, p_action: action, ...extra });
    if (error?.code === "42501") throw new WorkspaceAccessError("You do not have access to this workspace.", 403);
    if (error || !data) throw unavailable();
    return data;
  }
  const { clientId, clientSecret } = notionOAuthCredentials();
  const claim = await rotate("claim");
  if (claim.state === "reconnect") throw reconnect();
  if (claim.state === "busy" || claim.state === "changed") {
    for (let tries = 0; tries < 8; tries++) {
      if (tries) await new Promise(resolve => setTimeout(resolve, 1000));
      const { data, error } = await access.admin.rpc("hush_get_notion_connection", {
        p_workspace_id: access.workspaceId, p_user_id: access.user.id,
      });
      if (error) throw unavailable();
      if (!data) throw reconnect();
      if (typeof data.access_token_encrypted === "string" && data.access_token_encrypted !== expected) {
        return data.access_token_encrypted;
      }
      if (claim.state === "changed") break;
    }
    throw unavailable();
  }
  if (claim.state !== "claimed" || typeof claim.refresh !== "string") throw unavailable();

  let response: Response;
  try {
    response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json", Accept: "application/json", "Notion-Version": "2025-09-03",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: decryptNotionToken(claim.refresh, access.workspaceId, "refresh"),
      }),
      cache: "no-store", signal: AbortSignal.timeout(18000),
    });
  } catch {
    // A timeout may have consumed the rotating token. Do not retry it.
    await rotate("fail");
    throw reconnect();
  }

  if (response.status === 429) {
    await rotate("release");
    throw unavailable();
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token ||
      typeof body?.refresh_token !== "string" || !body.refresh_token) {
    await rotate("fail");
    throw reconnect();
  }
  const newAccess = encryptNotionToken(body.access_token, access.workspaceId);
  const newRefresh = encryptNotionToken(body.refresh_token, access.workspaceId, "refresh");
  const expiry = typeof body.expires_in === "number" && body.expires_in > 0 && body.expires_in < 315360000
    ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  const result = await rotate("finish", { p_access: newAccess, p_refresh: newRefresh, p_expires_at: expiry });
  if (result.state !== "saved") throw unavailable();
  return newAccess;
}
