import { ECDH } from "node:crypto";
import { readPushSubscription as parsePushSubscription } from "../supabase/functions/_shared/push-subscription.mjs";

export function readPushSubscription(value) {
  const subscription = parsePushSubscription(value);
  if (!subscription) return null;
  const key = Buffer.from(subscription.keys.p256dh, "base64url");
  try { ECDH.convertKey(key, "prime256v1"); } catch { return null; }
  return subscription;
}
