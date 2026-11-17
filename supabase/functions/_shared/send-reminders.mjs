import { readPushSubscription } from "./push-subscription.mjs";

export async function sendDueReminders(db, sendNotification, vapidDetails) {
  const batches = await Promise.allSettled([
    sendBatch("hush_due_reminders"),
    sendBatch("hush_due_team_updates"),
  ]);
  return batches.every((batch) => batch.status === "fulfilled" && batch.value);

  async function sendBatch(rpc) {
    try {
      const { data, error } = await db.rpc(rpc);
      if (error) {
        console.error("Could not check due reminders.", rpc, error.code);
        return false;
      }
      const results = await Promise.allSettled((data ?? []).map(sendReminder));
      return results.every((result) => result.status === "fulfilled" && result.value);
    } catch {
      console.error("Could not reach the reminder database.", rpc);
      return false;
    }
  }

  async function sendReminder(job) {
    let outcome = "failed";
    let expired = false;
    try {
      const subscription = readPushSubscription(job.subscription);
      if (subscription) {
        const payload = job.phase
          ? { id: job.id, kind: "team-update", phase: job.phase }
          : { id: job.id, taskId: job.task_id };
        await sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails,
          TTL: 60 * 60,
          timeout: 15_000,
        });
        outcome = "accepted";
      }
    } catch (error) {
      const status = error?.statusCode;
      expired = status === 404 || status === 410;
      console.error("Push delivery failed.", Number.isInteger(status) ? status : "Push service unavailable.");
    }

    const result = { p_id: job.id, p_outcome: outcome };
    try {
      const { error } = job.phase
        ? await db.rpc("hush_finish_team_update", { ...result, p_expired: expired })
        : await db.rpc("hush_finish_reminder", result);
      if (!error) return true;
      console.error("Could not record a reminder result.", error.code);
    } catch {
      console.error("Could not record a reminder result.");
    }
    return false;
  }
}
