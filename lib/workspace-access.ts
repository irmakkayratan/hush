import "server-only";

import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "./supabase-admin";

export class WorkspaceAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export async function requireWorkspaceAccess(
  request: Request,
  workspaceId: string,
  options: { requirePM?: boolean } = {}
) {
  if (
    typeof workspaceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)
  ) {
    throw new WorkspaceAccessError("Choose a valid workspace.", 400);
  }

  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    throw new WorkspaceAccessError("Please sign in first.", 401);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new WorkspaceAccessError("Server connection settings are missing.", 500);
  }

  const authClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(match[1]);
  if (error || !data.user) {
    throw new WorkspaceAccessError("Please sign in again.", 401);
  }

  const admin = createSupabaseAdminClient();
  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (membershipError) {
    throw new WorkspaceAccessError("Could not verify workspace access.", 503);
  }
  if (!membership) {
    throw new WorkspaceAccessError("You do not have access to this workspace.", 403);
  }
  if (options.requirePM && membership.role !== "pm") {
    throw new WorkspaceAccessError("Only a workspace PM can change this connection.", 403);
  }

  return { user: data.user, workspaceId, role: membership.role as string, admin };
}
