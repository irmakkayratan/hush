import { NextResponse } from "next/server";
import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";
import { createNotionOAuthState, notionOAuthConfig, OAUTH_COOKIE } from "@/lib/notion-oauth";

export async function POST(request: Request) {
  // Keep the unfinished connection flow local until callback and source selection are tested.
  if (process.env.NODE_ENV !== "development") {
    return new Response("Not found", { status: 404 });
  }
  try {
    const config = notionOAuthConfig();
    if (request.headers.get("Origin") !== config.origin) {
      return Response.json({ message: "Start the connection from HUSH." }, { status: 403 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ message: "Invalid request." }, { status: 400 });
    }
    if (!body || typeof body.workspaceId !== "string") {
      return Response.json({ message: "Choose a workspace first." }, { status: 400 });
    }
    const access = await requireWorkspaceAccess(request, body.workspaceId, { requirePM: true });
    const { state, cookie } = createNotionOAuthState(access.user.id, access.workspaceId);
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("state", state);
    const response = NextResponse.json({ authorizationUrl: url.toString() });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: config.secure,
      sameSite: "lax",
      path: "/api/notion/oauth",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    return Response.json({ message: "Could not start the Notion connection. Check the server OAuth settings." }, { status: 503 });
  }
}
