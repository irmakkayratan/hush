import { supabase } from "@/lib/supabase";

export async function teamUpdateRequest(workspaceId: string, userId: string, payload?: object, signal?: AbortSignal) {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user.id !== userId) throw new Error("Sign in again to access team updates.");
  const query = new URLSearchParams({ workspaceId });
  const response = await fetch(`/api/team-updates?${query}`, {
    method: payload ? "POST" : "GET",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: payload ? JSON.stringify({ ...payload, workspaceId }) : undefined,
    cache: "no-store",
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message ?? "Could not reach team updates. Try again.");
  return result;
}

export async function disableTeamNotifications(workspaceId: string, userId: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const worker = await navigator.serviceWorker.getRegistration("/");
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription) {
    await teamUpdateRequest(workspaceId, userId, { kind: "disable-notifications", endpoint: subscription.endpoint },
      AbortSignal.timeout(5000));
  }
}
