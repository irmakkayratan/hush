import { buildPushPayload } from "npm:@block65/webcrypto-web-push@2.0.0";

export async function sendNotification(subscription, payload, { vapidDetails, TTL, timeout }) {
  const request = await buildPushPayload(
    { data: payload, options: { ttl: TTL } },
    { ...subscription, expirationTime: null },
    vapidDetails,
  );
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const response = await fetch(subscription.endpoint, {
    ...request,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw Object.assign(new Error("Push service rejected the notification."), { statusCode: response.status });
  }
}
