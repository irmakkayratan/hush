import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!authorization) return Response.json({ message: "Please sign in first." }, { status: 401 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Missing settings");
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser(authorization[1]);
    if (error || !data.user) return Response.json({ message: "Please sign in again." }, { status: 401 });
    if (!data.user.email_confirmed_at) return Response.json({ message: "Verify your email before creating a team." }, { status: 403 });
    let body;
    try { body = await readRequestBody(request, 4 * 1024).json(); } catch (error) {
      return Response.json({ message: "Invalid team request." }, { status: error instanceof RequestBodyTooLarge ? 413 : 400 });
    }
    if (!body || typeof body.name !== "string" || typeof body.workspaceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.workspaceId)) {
      return Response.json({ message: "Enter a valid team name." }, { status: 400 });
    }
    const name = body.name.replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 80) return Response.json({ message: "Use a team name between 2 and 80 characters." }, { status: 400 });
    const admin = createSupabaseAdminClient();
    const result = await admin.rpc("hush_create_team", { p_user_id: data.user.id, p_workspace_id: body.workspaceId, p_name: name });
    if (result.error) {
      const known = result.error.code === "22023" || result.error.code === "42501";
      return Response.json({ message: known ? result.error.message : "Could not create the team. Check that the team setup SQL has been run." }, { status: known ? 400 : 503 });
    }
    return Response.json({ created: true, workspace: result.data });
  } catch { return Response.json({ message: "Could not confirm team creation. Retry here with the same team name." }, { status: 503 }); }
}
