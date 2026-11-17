function acceptsEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;

  const { hostname, pathname } = url;
  return ((hostname === "web.push.apple.com" || hostname.endsWith(".push.apple.com")) && pathname.startsWith("/"))
    || (hostname === "fcm.googleapis.com" && pathname.startsWith("/fcm/send/"))
    || (hostname === "updates.push.services.mozilla.com" && pathname.startsWith("/wpush/"))
    || (hostname.endsWith(".notify.windows.com") && pathname.startsWith("/w/"));
}

export function readPushSubscription(value) {
  if (!value || !acceptsEndpoint(value.endpoint)) return null;
  const { p256dh, auth } = value.keys ?? {};
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(p256dh)
    || typeof auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;

  // A 65-byte uncompressed P-256 key starts with the byte 0x04.
  if (!/^B[A-P]/.test(p256dh)) return null;
  return { endpoint: new URL(value.endpoint).href, keys: { p256dh, auth } };
}
