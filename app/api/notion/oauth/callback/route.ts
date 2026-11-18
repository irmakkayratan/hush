import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import {
  notionOAuthConfig, OAUTH_COOKIE, OAUTH_PENDING_COOKIE,
  verifyNotionOAuthState, sealPendingNotionGrant,
} from "@/lib/notion-oauth";

export async function GET(request: NextRequest) {
  let config;
  try { config = notionOAuthConfig(); } catch {
    return new Response("Notion OAuth settings are missing or invalid.", { status: 503 });
  }
  const finish = (status: string, pending?: string) => {
    const destination = new URL("/connect-notion", config.origin);
    destination.searchParams.set("oauth", status);
    const response = NextResponse.redirect(destination, 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    const options = { httpOnly: true, secure: config.secure, sameSite: "lax" as const, path: "/api/notion/oauth" };
    response.cookies.set(OAUTH_COOKIE, "", { ...options, maxAge: 0 });
    response.cookies.set(OAUTH_PENDING_COOKIE, pending || "", { ...options, maxAge: pending ? 600 : 0 });
    return response;
  };
  try {
    const state = request.nextUrl.searchParams.get("state") || "";
    const cookie = request.cookies.get(OAUTH_COOKIE)?.value || "";
    const context = verifyNotionOAuthState(cookie, state);
    if (request.nextUrl.searchParams.has("error")) return finish("cancelled");
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 4096) return finish("invalid");
    const admin = createSupabaseAdminClient();
    const membership = await admin.from("memberships").select("role")
      .eq("workspace_id", context.workspaceId).eq("user_id", context.userId).maybeSingle();
    if (membership.error || membership.data?.role !== "pm") return finish("denied");
    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json", "Notion-Version": "2025-09-03",
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
      cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return finish("exchange_failed");
    const token = await response.json();
    if (typeof token.access_token !== "string" || !token.access_token) return finish("exchange_failed");
    const pending = sealPendingNotionGrant({
      userId: context.userId, workspaceId: context.workspaceId,
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
      notionWorkspaceId: typeof token.workspace_id === "string" ? token.workspace_id : null,
      notionWorkspaceName: typeof token.workspace_name === "string" ? token.workspace_name : null,
      tokenExpiresAt: typeof token.expires_in === "number" && token.expires_in > 0
        ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return finish("select_sources", pending);
  } catch {
    return finish("failed");
  }
}
