import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { sendNotification } from "./web-push.mjs";
import { sendDueReminders } from "../_shared/send-reminders.mjs";

const url = Deno.env.get("SUPABASE_URL");
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const serviceKey = secretKeys.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = Deno.env.get("HUSH_CRON_SECRET");
const publicKey = Deno.env.get("NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY");
const privateKey = Deno.env.get("HUSH_PUSH_PRIVATE_KEY");
const subject = Deno.env.get("HUSH_PUSH_SUBJECT");

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!cronSecret || !/^[a-f0-9]{64}$/.test(cronSecret)) return new Response(null, { status: 503 });

  const token = request.headers.get("x-hush-cron-secret") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))) {
    return new Response(null, { status: 401 });
  }
  if (!url || !serviceKey || !publicKey || !privateKey || !subject) {
    return new Response(null, { status: 503 });
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
  const ok = await sendDueReminders(db, sendNotification, { subject, publicKey, privateKey });
  return new Response(null, { status: ok ? 204 : 502 });
});
