import { createHash, randomBytes } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (message: string, status: number) =>
  Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!bearer) return reply("Sign in first.", 401);
  try {
    const admin = createSupabaseAdminClient();
    const { data: { user }, error } = await admin.auth.getUser(bearer[1]);
    if (error || !user) return reply("Sign in again.", 401);
    const body = await request.json().catch(() => null);

    if (body?.action === "create") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (typeof body.workspaceId !== "string" || !uuid.test(body.workspaceId) ||
          email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply("Choose a team and enter a valid email address.", 400);
      }
      const token = randomBytes(32).toString("base64url");
      const result = await admin.rpc("hush_create_team_invite", {
        p_user_id: user.id, p_workspace_id: body.workspaceId, p_email: email, p_token_hash: digest(token),
      });
      if (result.error?.code === "42501") return reply("Only a team administrator can create invitations.", 403);
      if (result.error) return reply("Could not create the invitation.", 503);
      return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body?.action === "accept") {
      if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
        return reply("Open a valid invitation link.", 400);
      }
      if (!user.email || !user.email_confirmed_at) return reply("Sign in with the verified email that was invited.", 403);
      const result = await admin.rpc("hush_accept_team_invite", {
        p_user_id: user.id, p_verified_email: user.email, p_token_hash: digest(body.token),
      });
      if (result.error?.code === "42501") return reply("This invitation is unavailable for this account. Check the email and expiry.", 403);
      if (result.error) return reply("Could not confirm that you joined. You can retry with the same link.", 503);
      return Response.json({ workspace: result.data }, { headers: { "Cache-Control": "no-store" } });
    }
    return reply("Invalid request.", 400);
  } catch {
    return reply("Could not complete the invitation request.", 503);
  }
}
