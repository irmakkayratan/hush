import { randomUUID } from "node:crypto";
import { getCaptureConnection } from "@/lib/notion-task-data";
import { MAX_NOTE_REQUEST_BYTES, readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";
import { WorkspaceAccessError } from "@/lib/workspace-access";

const normalizeId = (id: string) =>
  id.replace(/-/g, "").toLowerCase();

const isValidId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(
    value
  );

const firstText = (...values: unknown[]) =>
  values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0
  )?.trim();

export async function POST(request: Request) {
  let attemptedTaskId: string | undefined;
  const uncertain = (taskId?: string) => Response.json({
    deliveryUncertain: true, taskId,
    message: "Could not confirm delivery. Check the Notion task. HUSH will not send this note again.",
  }, { status: 409 });
  const statusWarning = "The update was added, but the status could not be confirmed. Check the task in Notion. Do not resend the note.";

  try {
    let body;
    try {
      body = await readRequestBody(request, MAX_NOTE_REQUEST_BYTES).json();
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return Response.json({ message: "The update is too large." }, { status: 413 });
      }
      return Response.json({ message: "Invalid request." }, { status: 400 });
    }
    const {
      captureId,
      taskId,
      summary,
      nextStep,
      nextPerson,
      suggestedStatus,
      currentStatus,
      confirmed,
    } = body ?? {};

    if (
      !isValidId(captureId) ||
      !isValidId(taskId) ||
      confirmed !== true ||
      typeof summary !== "string" ||
      !summary.trim() ||
      summary.length > 1800 ||
      typeof nextStep !== "string" ||
      nextStep.length > 1000 ||
      typeof nextPerson !== "string" ||
      nextPerson.length > 200 ||
      (suggestedStatus !== null &&
        (typeof suggestedStatus !== "string" ||
          suggestedStatus.length > 100)) ||
      (currentStatus !== null &&
        (typeof currentStatus !== "string" ||
          currentStatus.length > 100))
    ) {
      return Response.json(
        { message: "Please analyze the note again and review the update." },
        { status: 400 }
      );
    }

    const connection = await getCaptureConnection(request, captureId);
    const supabase = connection.admin;
    const userData = { user: connection.user };
    const attempt = randomUUID();
    const args = {
      p_workspace_id: connection.workspaceId, p_user_id: connection.user.id, p_capture_id: connection.note.id,
    };
    async function record(action: "check" | "claim" | "finish", fields = {}) {
      const result = await supabase.rpc("hush_notion_delivery", { ...args, p_action: action, ...fields });
      if (result.error?.code === "42501") throw new WorkspaceAccessError("Note not found or access denied.", 403);
      if (result.error || !result.data) throw new WorkspaceAccessError("Could not check delivery. No new update was sent.", 503);
      return result.data;
    }
    function previous(result: { state: string; taskId?: string; warning?: boolean; message?: string }) {
      if (result.state === "pending") return uncertain(result.taskId);
      if (result.state === "delivered") return Response.json({
        delivered: true, warning: result.warning === true, taskId: result.taskId,
        message: `Already sent. ${result.message || "No duplicate update was posted."}`,
      });
      throw new WorkspaceAccessError("Could not check delivery. No new update was sent.", 503);
    }
    const existing = await record("check");
    if (existing.state !== "new") return previous(existing);

    const taskResponse = await connection.readNotion(`pages/${taskId}`);

    if (!taskResponse.ok) {
      return Response.json(
        { message: "Could not verify the task. Nothing was sent.", deliveryUncertain: false },
        { status: 502 }
      );
    }

    const task = await taskResponse.json();
    const sourceId = task.parent?.data_source_id;

    const allowedSources = connection.sources.map(source => normalizeId(source.notion_data_source_id));

    if (
      task.object !== "page" ||
      task.parent?.type !== "data_source_id" ||
      typeof sourceId !== "string" ||
      !allowedSources.includes(normalizeId(sourceId)) ||
      task.archived ||
      task.in_trash
    ) {
      return Response.json(
        { message: "This task is outside the connected task lists or unavailable." },
        { status: 403 }
      );
    }

    const source = connection.sources.find(source => normalizeId(source.notion_data_source_id) === normalizeId(sourceId))!;
    type StatusProperty = { id: string; type: string; status?: { name?: string; options?: { id: string; name: string }[] } | null };
    const liveProperty = Object.values(task.properties as Record<string, StatusProperty>).find(p => p.id === source.status_property_id);
    const liveStatus = liveProperty?.status?.name ?? null;
    const shouldChangeStatus =
      suggestedStatus !== null && suggestedStatus !== liveStatus;

    if (suggestedStatus !== null && liveStatus !== currentStatus) {
      return Response.json(
        {
          message:
            "The task status changed since analysis. Analyze the note again.",
        },
        { status: 409 }
      );
    }

    let statusOptionId: string | null = null;

    if (shouldChangeStatus) {
      const schemaResponse = await connection.readNotion(`data_sources/${sourceId}`);
      if (!schemaResponse.ok) {
        return Response.json(
          { message: "Could not verify status options. Nothing was sent.", deliveryUncertain: false },
          { status: 502 }
        );
      }

      const schema = await schemaResponse.json();

      const schemaProperty = Object.values(schema.properties as Record<string, StatusProperty>).find(p => p.id === source.status_property_id && p.type === "status");
      const options = schemaProperty?.status?.options;

      statusOptionId =
        options?.find((option) => option.name === suggestedStatus)?.id ??
        null;

      if (!statusOptionId) {
        return Response.json(
          { message: "That status is unavailable. Analyze the note again." },
          { status: 400 }
        );
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userData.user.id)
      .maybeSingle();

    const metadata = userData.user.user_metadata ?? {};

    const authorName = firstText(
      metadata.hush_display_name,
      profile?.full_name,
      profile?.display_name,
      profile?.name,
      metadata.full_name,
      metadata.name
    )?.replace(/\s+/g, " ").slice(0, 80);

    const authorEmail = userData.user.email;
    const author = authorName
      ? authorEmail
        ? `${authorName} (${authorEmail})`
        : authorName
      : authorEmail || `Account ${userData.user.id}`;

    const postedAt = new Date().toISOString();

    const paragraph = (content: string) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content },
          },
        ],
      },
    });

    const children = [
      paragraph("HUSH update"),
      paragraph(`Posted by: ${author.slice(0, 800)}`),
      paragraph(`Posted at: ${postedAt} (UTC)`),
      paragraph(summary.trim()),
    ];

    if (nextStep.trim()) {
      children.push(paragraph(`Next step: ${nextStep.trim()}`));
    }

    if (nextPerson.trim()) {
      children.push(paragraph(`Next person: ${nextPerson.trim()}`));
    }

    const claim = await record("claim", { p_task_id: taskId, p_attempt_id: attempt });
    if (claim.state !== "claimed") return previous(claim);

    attemptedTaskId = taskId;
    const appendResponse = await fetch(
      `https://api.notion.com/v1/blocks/${taskId}/children`,
      {
        method: "PATCH",
        headers: connection.notionHeaders(),
        body: JSON.stringify({ children }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!appendResponse.ok) return uncertain(taskId);
    await appendResponse.body?.cancel().catch(() => {});

    let warning = false;
    let message = "Update sent to Notion.";
    if (shouldChangeStatus && statusOptionId) {
      try {
        const statusResponse = await fetch(`https://api.notion.com/v1/pages/${taskId}`, {
          method: "PATCH",
          headers: connection.notionHeaders(),
          body: JSON.stringify({ properties: { [source.status_property_id!]: { status: { id: statusOptionId } } } }),
          signal: AbortSignal.timeout(20000),
        });
        await statusResponse.body?.cancel().catch(() => {});
        warning = !statusResponse.ok;
      } catch { warning = true; }
      message = warning ? statusWarning : `Update sent. Status changed to ${suggestedStatus}.`;
    }
    try {
      const saved = await record("finish", { p_attempt_id: attempt, p_warning: warning, p_message: message });
      if (saved.state !== "delivered") throw new Error("Delivery confirmation missing");
    } catch {
      // Notion accepted the update, but the reservation must still prevent a retry.
      return Response.json({
        delivered: true, warning: true, taskId,
        message: `${message} HUSH could not save the confirmation. Do not resend this note.`,
      });
    }
    return Response.json({ delivered: true, warning, message, taskId });
  } catch (error) {
    if (attemptedTaskId) return uncertain(attemptedTaskId);
    if (error instanceof WorkspaceAccessError) {
      return Response.json({ message: error.message, deliveryUncertain: false }, { status: error.status });
    }
    return Response.json(
      { message: "Could not prepare the update. Nothing was sent.", deliveryUncertain: false },
      { status: 502 }
    );
  }
}
