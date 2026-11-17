self.addEventListener("push", (event) => {
  let reminder = {};
  try { reminder = event.data?.json() ?? {}; } catch {}

  const teamMessages = {
    scheduled: "A team update was scheduled. Open HUSH to see the deadline.",
    due: "You have a team update due. Open HUSH to see the deadline.",
    "follow-up": "Your team is waiting for an update. Open HUSH to submit it.",
  };
  const body = reminder.kind === "team-update"
    ? (Object.hasOwn(teamMessages, reminder.phase) ? teamMessages[reminder.phase] : teamMessages.due)
    : reminder.taskId ? "You have a scheduled task reminder. Tap to open the task." : "Your HUSH test reminder arrived.";
  event.waitUntil(self.registration.showNotification("HUSH", {
    body,
    icon: "/hush-icons/icon-192.png",
    tag: typeof reminder.id === "string" ? reminder.id : "hush-reminder",
    data: { taskId: reminder.taskId },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const destination = typeof taskId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskId)
    ? `https://www.notion.so/${taskId.replaceAll("-", "")}`
    : new URL("/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const window = windows.find((client) => client.url === destination);
    if (window) await window.focus();
    else await self.clients.openWindow(destination);
  })());
});
