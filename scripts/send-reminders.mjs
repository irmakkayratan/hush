import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { sendNotification } from "web-push";
import { sendDueReminders } from "../supabase/functions/_shared/send-reminders.mjs";

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

console.log("HUSH reminder worker is running.");
while (!shutdown.signal.aborted) {
  await sendDueReminders(db, sendNotification, { subject, publicKey, privateKey });
  await sleep(15_000, undefined, { signal: shutdown.signal }).catch(() => {});
}
