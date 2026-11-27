import { getWorkspaceNotionConnection, type NotionSource } from "@/lib/notion-connection";
import { notionOAuthConfig } from "@/lib/notion-oauth";
import { WorkspaceAccessError } from "@/lib/workspace-access";

const options = { headers: { "Cache-Control": "private, no-store" } };
const failure = (message: string, status: number) => Response.json({ message }, { ...options, status });

type NotionConnection = Awaited<ReturnType<typeof getWorkspaceNotionConnection>>;

function readError(status: number) {
  if (status === 403 || status === 404) {
    return new WorkspaceAccessError("Share this task list with HUSH in Notion, then check again.", 409);
  }
  if (status === 429) return new WorkspaceAccessError("Notion is rate limiting HUSH. Try again shortly.", 429);
  return new WorkspaceAccessError("Could not read this task list from Notion.", 502);
}

async function verifySource(connection: NotionConnection, source: NotionSource) {
  const response = await connection.readNotion(`data_sources/${source.notion_data_source_id}`, { timeout: 10000 });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw readError(response.status);
  }
  const schema = await response.json() as { properties?: Record<string, { id?: string; type?: string }> };
  const title = Object.values(schema.properties ?? {}).find(property => property.type === "title");
  // Some older connections recorded no title mapping and use Notion's current title field.
  if (!title?.id || (source.title_property_id && title.id !== source.title_property_id)) {
    throw new WorkspaceAccessError("Reconnect this task list to update its title field mapping.", 409);
  }
  return title.id;
}

async function connectionFor(request: Request, url: URL) {
  return getWorkspaceNotionConnection(request, url.searchParams.get("workspaceId") ?? "", { requirePM: true });
}

function chooseSource(connection: NotionConnection, sourceId: string) {
  const source = connection.sources.find(item => item.id === sourceId);
  if (!source) throw new WorkspaceAccessError("Choose a task list configured for this team.", 400);
  return source;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const connection = await connectionFor(request, url);
    const sources = connection.sources.map(({ id, name }) => ({ id, name }));
    if (!sources.length) return failure("Reconnect Notion and enable a task list first.", 409);

    const sourceId = url.searchParams.get("sourceId");
    if (!sourceId) return Response.json({ sources }, options);

    const source = chooseSource(connection, sourceId);
    await verifySource(connection, source);
    return Response.json({ connected: true, source: { id: source.id, name: source.name } }, options);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return failure(error.message, error.status);
    return failure("Could not check the saved Notion connection.", 503);
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("Origin") !== notionOAuthConfig().origin) {
      return failure("Create the test task from HUSH.", 403);
    }
    const url = new URL(request.url);
    const connection = await connectionFor(request, url);
    const source = chooseSource(connection, url.searchParams.get("sourceId") ?? "");
    const titleProperty = await verifySource(connection, source);

    // This write is deliberately attempted once. After an uncertain response, check
    // the selected list before sending a second write.
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: connection.notionHeaders(),
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: source.notion_data_source_id },
        properties: {
          [titleProperty]: { type: "title", title: [{ type: "text", text: { content: "[HUSH TEST] Notion connection" } }] },
        },
        children: [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "Created for a HUSH connection test. You can remove this task after checking it." } }] },
        }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 403 || response.status === 404) {
        return failure("Allow HUSH to insert content in this Notion task list, then try again.", 409);
      }
      if (response.status === 401) return failure("Reconnect Notion before creating a test task.", 409);
      if (response.status === 400) return failure("Notion rejected the test task. Check this list's configuration.", 422);
      if (response.status === 429) return failure("Notion is rate limiting HUSH. Try again shortly.", 429);
      return failure("Could not confirm the write. Check the task list before trying again.", 502);
    }
    const page = await response.json() as { id?: string };
    if (!page.id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(page.id)) {
      return failure("Could not confirm the write. Check the task list before trying again.", 502);
    }
    return Response.json({ taskUrl: `https://www.notion.so/${page.id.replaceAll("-", "")}` }, { ...options, status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return failure(error.message, error.status);
    return failure("Could not confirm the write. Check the task list before trying again.", 502);
  }
}
