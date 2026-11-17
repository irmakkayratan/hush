import { getCaptureConnection } from "@/lib/notion-task-data";
import { readPushSubscription } from "@/lib/push-subscription.mjs";
import { readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";
import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const reply = (message: string, status: number) => Response.json({ message }, { status });

export async function POST(request: Request) {
  if (!process.env.NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY) return reply("Reminders are unavailable on this server.", 503);

  try {
    let body;
    try {
      body = await readRequestBody(request, 8 * 1024).json();
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return reply("The reminder request is too large.", 413);
      return reply("Invalid reminder request.", 400);
    }

    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
    const subscription = readPushSubscription(body?.subscription);
    if (!subscription) return reply("Could not verify this browser’s notification subscription.", 400);

    let access;
    let taskId: string | null = null;
    let remindAt: Date;
    if (body?.kind === "test") {
      access = await requireWorkspaceAccess(request, workspaceId);
      remindAt = new Date(Date.now() + 60 * 1000);
    } else {
      if (body?.kind !== "task" || typeof body.taskId !== "string" || !uuid.test(body.taskId)
        || typeof body.captureId !== "string" || !uuid.test(body.captureId)
        || typeof body.remindAt !== "string") return reply("Choose a task and a reminder time.", 400);

      remindAt = new Date(body.remindAt);
      const delay = remindAt.getTime() - Date.now();
      if (!Number.isFinite(delay) || delay < 60 * 1000 || delay > MAX_AHEAD_MS) {
        return reply("Choose a reminder time between one minute and one year from now.", 400);
      }
      const connection = await getCaptureConnection(request, body.captureId);
      if (connection.workspaceId !== workspaceId) return reply("This note belongs to another team.", 403);
      const taskResponse = await connection.readNotion(`pages/${body.taskId}`);
      if (!taskResponse.ok) return reply("Could not verify the Notion task.", 502);
      const task = await taskResponse.json();
      if (task.object !== "page" || task.parent?.type !== "data_source_id" || task.archived || task.in_trash
        || !connection.sources.some(source => source.notion_data_source_id.toLowerCase() === String(task.parent.data_source_id).toLowerCase())) {
        return reply("This task is outside the connected task lists or unavailable.", 403);
      }
      access = connection;
      taskId = body.taskId;
    }

    const { data, error } = await access.admin.rpc("hush_schedule_reminder", {
      p_workspace_id: access.workspaceId, p_user_id: access.user.id, p_task_id: taskId,
      p_subscription: subscription, p_remind_at: remindAt.toISOString(),
    });
    if (error?.code === "42501") return reply("You do not have access to this team.", 403);
    if (error?.code === "22023") return reply("The reminder could not be scheduled at that time.", 400);
    if (error?.code === "54000") return reply("This account has reached the scheduled reminder limit.", 429);
    if (error || !data) return reply("Could not save the reminder. Try again.", 503);
    return Response.json({ remindAt: data.remindAt });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return reply(error.message, error.status);
    return reply("Could not save the reminder. Try again.", 503);
  }
}
