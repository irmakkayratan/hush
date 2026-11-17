import { readPushSubscription } from "@/lib/push-subscription.mjs";
import { readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";
import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const reply = (message: string, status: number) => Response.json({ message }, { status });

function validMinutes(value: unknown, min: number, max: number) {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
}

function validTimeZone(value: unknown) {
  if (typeof value !== "string" || value.length > 100 || !value) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

function failure(error: unknown) {
  if (error instanceof WorkspaceAccessError) return reply(error.message, error.status);
  return reply("Could not load team updates. Try again.", 503);
}

export async function GET(request: Request) {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
    const { admin, user } = await requireWorkspaceAccess(request, workspaceId);
    const { data, error } = await admin.rpc("hush_team_updates", {
      p_workspace_id: workspaceId, p_user_id: user.id,
    });
    if (error || !data) return failure(error);
    return Response.json(data);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  let body;
  try {
    body = await readRequestBody(request, 8 * 1024).json();
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return reply("The update request is too large.", 413);
    return reply("Invalid team update request.", 400);
  }

  try {
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
    const { admin, user, role } = await requireWorkspaceAccess(request, workspaceId);
    const scope = { p_workspace_id: workspaceId, p_user_id: user.id };
    if ((body.kind === "schedule" || body.kind === "cancel") && role !== "pm") {
      return reply("Only a team manager can change update schedules.", 403);
    }

    let result;
    switch (body?.kind) {
      case "schedule": {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || title.length > 100 || typeof body.instructions !== "string" || body.instructions.length > 1000 ||
          typeof body.id !== "string" || !uuid.test(body.id) || typeof body.localDue !== "string" || !localTime.test(body.localDue) ||
          !validTimeZone(body.timeZone) ||
          typeof body.weekly !== "boolean" || typeof body.announce !== "boolean" ||
          !validMinutes(body.reminderMinutes, 0, 2880) || !validMinutes(body.followUpMinutes, 1, 10080)) {
          return reply("Check the update title, deadline, time zone, and reminder times.", 400);
        }
        result = await admin.rpc("hush_schedule_team_update", {
          ...scope, p_id: body.id, p_title: title, p_instructions: body.instructions.trim(), p_local_due: body.localDue,
          p_time_zone: body.timeZone, p_weekly: body.weekly, p_announce: body.announce,
          p_reminder_minutes: body.reminderMinutes, p_follow_up_minutes: body.followUpMinutes,
        });
        break;
      }
      case "cancel": {
        if (typeof body.id !== "string" || !uuid.test(body.id)) return reply("Choose an update schedule.", 400);
        result = await admin.rpc("hush_cancel_team_update", { ...scope, p_id: body.id });
        break;
      }
      case "submit": {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 1800 || typeof body.roundId !== "string" || !uuid.test(body.roundId)) {
          return reply("Write an update of up to 1,800 characters.", 400);
        }
        result = await admin.rpc("hush_submit_team_update", { ...scope, p_round_id: body.roundId, p_text: text });
        break;
      }
      case "enable-notifications": {
        if (!process.env.NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY) return reply("Team notifications are unavailable on this server.", 503);
        const subscription = readPushSubscription(body.subscription);
        if (!subscription) return reply("Could not verify this device’s notification subscription.", 400);
        result = await admin.rpc("hush_save_team_update_device", { p_user_id: user.id, p_subscription: subscription });
        break;
      }
      case "disable-notifications": {
        if (typeof body.endpoint !== "string" || body.endpoint.length > 2048) return reply("Invalid notification device.", 400);
        result = await admin.rpc("hush_remove_team_update_device", { p_user_id: user.id, p_endpoint: body.endpoint });
        break;
      }
      default:
        return reply("Choose a valid team update action.", 400);
    }

    if (result.error?.code === "42501") return reply("You can’t make this change in this team.", 403);
    if (result.error?.code === "22023") return reply(result.error.message, 400);
    if (["22007", "22008", "23514"].includes(result.error?.code ?? "")) {
      return reply("Check the date, time, or text you entered.", 400);
    }
    if (result.error) return reply("Could not save the team update. Try again.", 503);
    return Response.json({ saved: true });
  } catch (error) {
    return failure(error);
  }
}
