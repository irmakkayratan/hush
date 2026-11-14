import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";

const options = { headers: { "Cache-Control": "no-store" } };
const failure = (message: string, status: number) => Response.json({ message }, { ...options, status });

async function manage(request: Request, disconnect: boolean) {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  if (disconnect && request.headers.get("Origin") !== url.origin) return failure("Invalid request origin.", 403);
  try {
    const id = url.searchParams.get("workspaceId") || "";
    const { user, admin } = await requireWorkspaceAccess(request, id, { requirePM: true });
    const result = await admin.rpc("hush_manage_notion_connection", {
      p_user_id: user.id, p_workspace_id: id, p_disconnect: disconnect,
    });
    if (result.error?.code === "42501") return failure("Only a team administrator can manage this connection.", 403);
    if (result.error) return failure("Could not manage the Notion connection.", 503);
    return Response.json(result.data, options);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return failure(error.message, error.status);
    return failure("Could not manage the Notion connection.", 503);
  }
}

export function GET(request: Request) { return manage(request, false); }
export function DELETE(request: Request) { return manage(request, true); }
