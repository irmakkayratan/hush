import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";
import { readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";
import { notionOAuthConfig, openPendingNotionGrant, OAUTH_PENDING_COOKIE } from "@/lib/notion-oauth";
import { encryptNotionToken } from "@/lib/notion-crypto";

type Property = { id: string; type: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function context(request: NextRequest) {
  const grant = openPendingNotionGrant(request.cookies.get(OAUTH_PENDING_COOKIE)?.value || "");
  const access = await requireWorkspaceAccess(request, grant.workspaceId, { requirePM: true });
  if (access.user.id !== grant.userId) throw new WorkspaceAccessError("Return with the account that started this connection.", 403);
  return { grant, access };
}
async function notion(token: string, path: string, body?: object) {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2025-09-03" },
    ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new WorkspaceAccessError("Could not read the shared Notion sources. Try connecting again.", 502);
  return response.json();
}
function failure(error: unknown) {
  return NextResponse.json({ message: error instanceof WorkspaceAccessError ? error.message : "This connection setup expired or could not be completed. Start again." }, { status: error instanceof WorkspaceAccessError ? error.status : 409, headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: NextRequest) {
  try {
    const { grant, access } = await context(request);
    const cursor = request.nextUrl.searchParams.get("cursor");
    if (cursor && cursor.length > 500) return NextResponse.json({ message: "Invalid cursor." }, { status: 400 });
    const result = await notion(grant.accessToken, "search", { filter: { property: "object", value: "data_source" }, page_size: 50, ...(cursor ? { start_cursor: cursor } : {}) });
    const existing = await access.admin.rpc("hush_get_notion_connection", { p_workspace_id: access.workspaceId, p_user_id: access.user.id });
    if (existing.error) throw new Error("Connection lookup failed");
    type SourceData = { object: string; id: string; title?: { plain_text: string }[]; properties?: Record<string, Property> };
    const found = new Map<string, SourceData>();
    for (const source of result.results as SourceData[]) {
      if (source.object === "data_source") found.set(source.id.toLowerCase(), source);
    }
    // Search can omit shared sources. Probe this team's previously saved sources
    // using only the NEW OAuth token, never the previous connection token.
    const previousSources = existing.data?.sources;
    if (!cursor && Array.isArray(previousSources)) {
      for (const previous of previousSources) {
        const id = previous?.notion_data_source_id;
        if (typeof id !== "string" || !uuid.test(id) || found.has(id.toLowerCase())) continue;
        await new Promise(resolve => setTimeout(resolve, 350));
        try {
          const source = await notion(grant.accessToken, `data_sources/${id}`) as SourceData;
          if (source.object === "data_source") found.set(source.id.toLowerCase(), source);
        } catch {
          // A source not accessible through the new grant is never offered.
        }
      }
    }
    const sources = Array.from(found.values()).map(source => ({
      id: source.id,
      name: source.title?.map(t => t.plain_text).join("") || "Untitled",
      properties: Object.entries(source.properties || {}).map(([name, p]) => ({ id: p.id, name: name || "Title", type: p.type })),
    }));
    return NextResponse.json({ workspaceId: access.workspaceId, notionWorkspaceName: grant.notionWorkspaceName, hasExistingConnection: Boolean(existing.data), sources, nextCursor: result.has_more ? result.next_cursor : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const config = notionOAuthConfig();
    if (request.headers.get("Origin") !== config.origin) throw new WorkspaceAccessError("Save the connection from HUSH.", 403);
    const { grant, access } = await context(request);
    let body;
    try { body = await readRequestBody(request, 16 * 1024).json(); } catch (error) { throw new WorkspaceAccessError("Invalid request.", error instanceof RequestBodyTooLarge ? 413 : 400); }
    if (!body || !Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > 20) throw new WorkspaceAccessError("Select between 1 and 20 task sources.", 400);
    const existing = await access.admin.rpc("hush_get_notion_connection", { p_workspace_id: access.workspaceId, p_user_id: access.user.id });
    if (existing.error) throw new Error("Connection lookup failed");
    if (existing.data && body.replaceConfirmed !== true) throw new WorkspaceAccessError("Confirm replacing the current connection first.", 409);
    const sources = [];
    const ids = new Set<string>();
    for (const selection of body.sources) {
      if (!selection || typeof selection.id !== "string" || !uuid.test(selection.id) || ids.has(selection.id.toLowerCase())) throw new WorkspaceAccessError("Invalid task source selection.", 400);
      ids.add(selection.id.toLowerCase());
      const source = await notion(grant.accessToken, `data_sources/${selection.id}`);
      const properties = Object.values(source.properties as Record<string, Property>);
      const title = properties.find(p => p.id === selection.titlePropertyId && p.type === "title");
      const status = properties.find(p => p.id === selection.statusPropertyId && p.type === "status");
      const date = selection.datePropertyId ? properties.find(p => p.id === selection.datePropertyId && p.type === "date") : null;
      if (!title || !status || (selection.datePropertyId && !date) || typeof selection.dateIsDeadline !== "boolean") throw new WorkspaceAccessError("Check each source's title, status and date fields.", 400);
      sources.push({ notion_data_source_id: selection.id, name: (source.title?.map((t: { plain_text: string }) => t.plain_text).join("") || "Tasks").slice(0, 200), title_property_id: title.id, status_property_id: status.id, date_property_id: date?.id ?? null, date_is_deadline: Boolean(date && selection.dateIsDeadline) });
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    const saved = await access.admin.rpc("hush_save_notion_connection", {
      p_workspace_id: access.workspaceId, p_user_id: access.user.id,
      p_access_token_encrypted: encryptNotionToken(grant.accessToken, access.workspaceId),
      p_refresh_token_encrypted: grant.refreshToken ? encryptNotionToken(grant.refreshToken, access.workspaceId, "refresh") : null,
      p_sources: sources, p_connection_type: "oauth", p_notion_workspace_id: grant.notionWorkspaceId,
      p_notion_workspace_name: grant.notionWorkspaceName?.slice(0, 300) ?? null, p_token_expires_at: grant.tokenExpiresAt,
    });
    if (saved.error) throw new Error("Connection save failed");
    const response = NextResponse.json({ saved: true, sourceCount: sources.length }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(OAUTH_PENDING_COOKIE, "", { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/api/notion/oauth", maxAge: 0 });
    return response;
  } catch (error) { return failure(error); }
}
