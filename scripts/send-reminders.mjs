import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { sendNotification } from "web-push";
import { readPushSubscription } from "../lib/push-subscription.mjs";

const {
  NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret,
  NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY: publicKey, HUSH_PUSH_PRIVATE_KEY: privateKey,
  HUSH_PUSH_SUBJECT: subject,
} = process.env;
if (!url || !secret || !publicKey || !privateKey || !subject) {
  console.error("Missing Supabase or Web Push settings. See README.md.");
  process.exit(1);
}

const db = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

async function sendReminder(job) {
  let outcome = "failed";
  try {
    const subscription = readPushSubscription(job.subscription);
    if (subscription) {
      await sendNotification(subscription, JSON.stringify({ id: job.id, taskId: job.task_id }), {
        vapidDetails: { subject, publicKey, privateKey },
        TTL: 60 * 60, timeout: 15_000,
      });
      outcome = "accepted";
    }
  } catch (error) {
    console.error("Push delivery failed.", Number.isInteger(error.statusCode) ? error.statusCode : "Push service unavailable.");
  }
  const { error } = await db.rpc("hush_finish_reminder", { p_id: job.id, p_outcome: outcome });
  if (error) console.error("Could not record a reminder result.", error.code);
}

console.log("HUSH reminder worker is running.");
while (!shutdown.signal.aborted) {
  try {
    const { data, error } = await db.rpc("hush_due_reminders");
    if (error) console.error("Could not check due reminders.", error.code);
    else await Promise.allSettled(data.map(sendReminder));
  } catch {
    console.error("Could not reach the reminder database.");
  }
  await sleep(15_000, undefined, { signal: shutdown.signal }).catch(() => {});
}
