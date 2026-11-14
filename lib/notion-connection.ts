import "server-only";

import { renewNotionAccess } from "./notion-refresh";
import { decryptNotionToken } from "./notion-crypto";
import { requireWorkspaceAccess, WorkspaceAccessError } from "./workspace-access";

export type NotionSource = {
  id: string;
  notion_data_source_id: string;
  name: string;
  title_property_id: string | null;
  status_property_id: string | null;
  date_property_id: string | null;
  date_is_deadline: boolean;
};

export async function getWorkspaceNotionConnection(
  request: Request,
  workspaceId: string
) {
  const access = await requireWorkspaceAccess(request, workspaceId);
  const { data, error } = await access.admin.rpc("hush_get_notion_connection", {
    p_workspace_id: access.workspaceId,
    p_user_id: access.user.id,
  });

  if (error) {
    throw new WorkspaceAccessError("Could not load the workspace connection.", 503);
  }
  if (!data) {
    throw new WorkspaceAccessError("Connect Notion to this workspace first.", 409);
  }
  if (
    typeof data !== "object" ||
    data.workspace_id !== access.workspaceId.toLowerCase() ||
    typeof data.access_token_encrypted !== "string" ||
    !Array.isArray(data.sources)
  ) {
    throw new WorkspaceAccessError("The workspace connection is invalid.", 503);
  }

  const sources: NotionSource[] = data.sources.map((source: unknown) => {
    if (!source || typeof source !== "object") {
      throw new WorkspaceAccessError("The task source settings are invalid.", 503);
    }
    const value = source as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.notion_data_source_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.notion_data_source_id) ||
      typeof value.name !== "string" ||
      typeof value.date_is_deadline !== "boolean"
    ) {
      throw new WorkspaceAccessError("The task source settings are invalid.", 503);
    }
    const optionalProperty = (key: string) => {
      const item = value[key];
      if (item == null) return null;
      if (typeof item !== "string") {
        throw new WorkspaceAccessError("The task source settings are invalid.", 503);
      }
      return item;
    };
    return {
      id: value.id,
      notion_data_source_id: value.notion_data_source_id,
      name: value.name,
      title_property_id: optionalProperty("title_property_id"),
      status_property_id: optionalProperty("status_property_id"),
      date_property_id: optionalProperty("date_property_id"),
      date_is_deadline: value.date_is_deadline,
    };
  });

  let encrypted = data.access_token_encrypted as string;
  function openToken(value: string) {
    try { return decryptNotionToken(value, access.workspaceId); }
    catch { throw new WorkspaceAccessError("Could not open the workspace connection.", 503); }
  }
  let token = openToken(encrypted);
  let renewal: Promise<void> | undefined;
  function renew() {
    renewal ??= (async () => {
      encrypted = await renewNotionAccess(access, encrypted);
      token = openToken(encrypted);
    })();
    return renewal;
  }
  async function readNotion(path: string, options?: { query?: object; timeout?: number }) {
    const url = `https://api.notion.com/v1/${path}`;
    const call = () => fetch(url, {
      method: options?.query ? "POST" : "GET",
      headers: notionHeaders(),
      ...(options?.query ? { body: JSON.stringify(options.query) } : {}),
      cache: "no-store", signal: AbortSignal.timeout(options?.timeout ?? 20000),
    });
    let response = await call();
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      await renew();
      response = await call();
      if (response.status === 401) throw new WorkspaceAccessError(
        "Ask your team administrator to reconnect Notion in Connect Notion.", 409
      );
    }
    return response;
  }
  function notionHeaders() {
    return { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
  }

  // Keep the connection on the server. Only read operations can be retried.
  return { ...access, sources, readNotion, notionHeaders };
}
