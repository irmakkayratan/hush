"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

const publicKey = process.env.NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY;

type ReminderControlsProps = {
  workspaceId: string;
  userId: string;
  task?: { id: string; captureId: string };
  initialTime?: string;
};

function localTime(iso?: string) {
  if (!iso || !iso.includes("T")) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function ReminderControls({ workspaceId, userId, task, initialTime }: ReminderControlsProps) {
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const active = useRef(false);
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(() => localTime(initialTime));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!publicKey || !window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)
      || !("Notification" in window)) return;
    let cancelled = false;
    void navigator.serviceWorker.register("/hush-worker.js")
      .then(() => navigator.serviceWorker.ready)
      .then((worker) => {
        if (cancelled) return;
        registration.current = worker;
        setReady(true);
      }).catch(() => { if (!cancelled) setMessage("Could not prepare notifications in this browser."); });
    return () => { cancelled = true; };
  }, []);

  async function schedule() {
    if (!publicKey || !registration.current || active.current) return;
    const remindAt = task ? new Date(time) : null;
    if (remindAt && !Number.isFinite(remindAt.getTime())) {
      setMessage("Choose a date and time for the reminder.");
      return;
    }
    active.current = true;
    setBusy(true);
    setMessage("");
    try {
      // Start the permission request directly from the button gesture on iPhone.
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications in your device settings to receive reminders.");
      const subscription = await registration.current.pushManager.getSubscription()
        ?? await registration.current.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user.id !== userId) throw new Error("Sign in again to schedule this reminder.");
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId, subscription: subscription.toJSON(),
          ...(task
            ? { kind: "task", taskId: task.id, captureId: task.captureId, remindAt: remindAt?.toISOString() }
            : { kind: "test" }),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.remindAt !== "string") {
        throw new Error(result?.message ?? "Could not schedule the reminder. Try again.");
      }
      const scheduled = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(result.remindAt));
      setMessage(`${task ? "Reminder" : "Test reminder"} scheduled for ${scheduled} on this device.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not schedule the reminder. Try again.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  if (!publicKey) return null;

  return (
    <details className={task ? "mt-4 text-sm" : "mt-6 text-left text-sm"}>
      <summary className="cursor-pointer py-2 underline">{task ? "Set a task reminder" : "Test notifications"}</summary>
      {!ready && <p className="mt-2 text-gray-600">On iPhone, add HUSH to your Home Screen and open it there to enable notifications.</p>}
      <form className="mt-2" onSubmit={(event) => { event.preventDefault(); void schedule(); }}>
        {task && (
          <label className="block">
            Reminder time
            <input type="datetime-local" required value={time} onChange={(event) => setTime(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-gray-500 px-3 py-2" />
          </label>
        )}
        <button type="submit" disabled={!ready || busy}
          className="mt-3 rounded-full border border-black px-4 py-2 disabled:opacity-50">
          {task ? "Schedule reminder" : "Schedule a test in one minute"}
        </button>
      </form>
      {message && <p role="status" className="mt-2">{message}</p>}
    </details>
  );
}
