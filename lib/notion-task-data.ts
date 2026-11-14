import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "./supabase-admin";
import { getWorkspaceNotionConnection } from "./notion-connection";
import { WorkspaceAccessError } from "./workspace-access";

export async function getCaptureConnection(request: Request, captureId: string) {
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(captureId)) {
    throw new WorkspaceAccessError("A saved note is required.", 400);
  }
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!bearer) throw new WorkspaceAccessError("Please sign in first.", 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new WorkspaceAccessError("Connection settings are missing.", 500);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(bearer[1]);
  if (error || !data.user) throw new WorkspaceAccessError("Please sign in again.", 401);
  const admin = createSupabaseAdminClient();
  const { data: note, error: noteError } = await admin.from("captures")
    .select("id, workspace_id, note_text")
    .eq("id", captureId).eq("uploaded_by", data.user.id).eq("file_type", "text").single();
  if (noteError || !note || typeof note.note_text !== "string" || !note.note_text.trim()) {
    throw new WorkspaceAccessError("Note not found or access denied.", 403);
  }
  const connection = await getWorkspaceNotionConnection(request, note.workspace_id);
  return { ...connection, note: { ...note, note_text: note.note_text as string } };
}

type Property = {
  id: string; type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  people?: { id: string; name?: string | null }[];
  status?: { name: string; options?: { id: string; name: string }[] } | null;
  date?: { start: string; end: string | null; time_zone?: string | null } | null;
  relation?: { id: string }[];
  multi_select?: { name: string }[];
};
export type WorkspaceTask = {
  id: string; name: string; source: string; description: string;
  owners: { id: string; name: string }[];
  status: string | null;
  due: Property["date"]; date: Property["date"];
  projects?: { id: string; name: string }[]; projectIds: string[]; channels: string[]; contentTypes: string[];
};

export async function readWorkspaceTasks(connection: Awaited<ReturnType<typeof getWorkspaceNotionConnection>>) {
  const tasks: WorkspaceTask[] = [];
  const statusOptions: Record<string, string[]> = {};
  let lastRequest = 0;
  async function read(path: string, body?: object) {
    const delay = 350 - (Date.now() - lastRequest);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = Date.now();
    const response = await connection.readNotion(path, { query: body });
    if (!response.ok) throw new WorkspaceAccessError("Could not read the workspace task lists.", 502);
    return response.json();
  }
  for (const source of connection.sources) {
    const schema = await read(`data_sources/${source.notion_data_source_id}`);
    const schemaProps = Object.values(schema.properties as Record<string, Property>);
    const statusProp = schemaProps.find(p => p.id === source.status_property_id);
    statusOptions[source.notion_data_source_id] = statusProp?.status?.options?.map(o => o.name) ?? [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await read(`data_sources/${source.notion_data_source_id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      if (!Array.isArray(page.results)) throw new WorkspaceAccessError("Invalid task list response.", 502);
      for (const item of page.results) {
        if (item.object !== "page" || item.archived || item.in_trash) continue;
        const props = item.properties as Record<string, Property>;
        const values = Object.values(props);
        const title = values.find(p => p.id === source.title_property_id);
        const date = values.find(p => p.id === source.date_property_id)?.date ?? null;
        tasks.push({
          id: item.id, source: source.notion_data_source_id,
          name: title?.title?.map(t => t.plain_text).join("") || "Untitled",
          description: props.Description?.rich_text?.map(t => t.plain_text).join("") || "",
          owners: (props.Owner?.people ?? []).map(p => ({ id: p.id, name: p.name || "" })),
          status: values.find(p => p.id === source.status_property_id)?.status?.name ?? null,
          due: source.date_is_deadline ? date : null,
          date: source.date_is_deadline ? null : date,
          projectIds: Array.from(new Set([...(props.Project?.relation ?? []), ...(props.PROJECTS?.relation ?? []), ...(props["Projects x Tasks"]?.relation ?? [])].map(p => p.id))),
          channels: (props.Channel?.multi_select ?? []).map(p => p.name),
          contentTypes: (props["Content Type"]?.multi_select ?? []).map(p => p.name),
        });
      }
      if (!page.has_more) break;
      const next: unknown = page.next_cursor;
      if (typeof next !== "string" || seen.has(next)) throw new WorkspaceAccessError("Invalid task pagination.", 502);
      seen.add(next); cursor = next;
    } while (true);
  }
  const projectNames = new Map<string, string>();
  for (const id of new Set(tasks.flatMap(task => task.projectIds))) {
    if (!/^[0-9a-f-]{32,36}$/i.test(id)) continue;
    try {
      const project = await read(`pages/${id}`);
      const title = Object.values(project.properties as Record<string, Property>).find(p => p.type === "title");
      projectNames.set(id, title?.title?.map(t => t.plain_text).join("") || "");
    } catch (error) {
      if (error instanceof WorkspaceAccessError && [403, 409, 503].includes(error.status)) throw error;
      // An inaccessible related project must not prevent matching its task.
      projectNames.set(id, "");
    }
  }
  for (const task of tasks) task.projects = task.projectIds.map(id => ({ id, name: projectNames.get(id) || "" }));
  return { tasks: Array.from(new Map(tasks.map(t => [t.id, t])).values()), statusOptions };
}
