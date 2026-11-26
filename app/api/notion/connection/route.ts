import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
    const { admin, user, role } = await requireWorkspaceAccess(request, workspaceId);
    const { data, error } = await admin.rpc("hush_get_notion_connection", {
      p_workspace_id: workspaceId,
      p_user_id: user.id,
    });
    if (error) throw new Error("Connection lookup failed");
    return Response.json({
      ready: Boolean(data && Array.isArray(data.sources) && data.sources.length),
      canManage: role === "pm",
    }, { headers });
  } catch (error) {
    return Response.json({
      message: error instanceof WorkspaceAccessError ? error.message : "Could not check the Notion connection. Try again.",
    }, { status: error instanceof WorkspaceAccessError ? error.status : 503, headers });
  }
}
