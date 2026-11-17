"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { disableTeamNotifications, teamUpdateRequest } from "@/lib/team-updates-client";
import { useVoiceRecording } from "./use-voice-recording";

type Submission = { submittedAt: string | null; update: string | null };
type UpdateRound = Submission & {
  id: string;
  scheduleId: string;
  title: string;
  instructions: string;
  dueAt: string;
  timeZone: string;
  weekly: boolean;
  assigned: boolean;
  members: Array<Submission & { id: string; name: string | null }>;
};
type TeamUpdatesData = { canManage: boolean; rounds: UpdateRound[] };

const publicKey = process.env.NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY;
const field = "mt-1 block w-full rounded-lg border border-[#BFC6BD] bg-white px-3 py-2 text-base";
const actionButton = "rounded-full border border-black px-4 py-2 text-sm disabled:opacity-50";

function formatDeadline(dueAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short",
  }).format(new Date(dueAt));
}

function submittedStatus(submittedAt: string | null, dueAt: string) {
  const deadline = Date.parse(dueAt);
  if (submittedAt) return Date.parse(submittedAt) > deadline ? "Submitted late" : "Submitted";
  return Date.now() > deadline ? "Overdue" : "Pending";
}

type TeamUpdateFormProps = {
  workspaceId: string;
  userId: string;
  actionRef: RefObject<boolean>;
  busy: boolean;
  onSubmit: (text: string) => void;
};

function TeamUpdateForm({ workspaceId, userId, actionRef, busy, onSubmit }: TeamUpdateFormProps) {
  const [text, setText] = useState("");
  const voice = useVoiceRecording({
    workspaceId,
    userId,
    actionRef,
    onTranscript: (transcript) => setText(previous => previous.trim() ? `${previous.trim()}\n\n${transcript}` : transcript),
    transcriptMessage: "Review or edit your transcript, then select Submit update.",
  });
  const recordingBusy = voice.isPreparingRecording || voice.isRecording || voice.isTranscribing;

  return (
    <form className="mt-3" onSubmit={event => {
      event.preventDefault();
      if (!busy && !recordingBusy && text.trim() && text.length <= 1800) onSubmit(text);
    }}>
      <label className="block text-sm">Your update
        <textarea name="update" className={field} rows={3} maxLength={1800} required
          value={text} onChange={event => setText(event.target.value)} disabled={busy || recordingBusy} />
      </label>
      <button type="button" className={`${actionButton} mt-2`}
        disabled={!voice.isRecording && (busy || recordingBusy)}
        onClick={voice.isRecording ? voice.stopRecording : voice.startRecording}>
        {voice.isRecording ? "Stop recording" : voice.isPreparingRecording ? "Opening microphone…" :
          voice.isTranscribing ? "Transcribing…" : "Record a voice update"}
      </button>
      {voice.voiceMessage && <p role="status" className="mt-2 whitespace-pre-wrap text-sm">{voice.voiceMessage}</p>}
      {voice.recordingUrl && <audio controls src={voice.recordingUrl} className="mt-2 w-full" />}
      {voice.transcriptionFailed && <button type="button" className={`${actionButton} mt-2`}
        disabled={busy || recordingBusy} onClick={voice.retryTranscription}>Try transcription again</button>}
      {text.length > 1800 && <p role="status" className="mt-2 text-sm">Shorten your update to 1800 characters before submitting.</p>}
      <div className="mt-2">
        <button type="submit" className={actionButton} disabled={busy || recordingBusy || !text.trim() || text.length > 1800}>
          Submit update
        </button>
      </div>
    </form>
  );
}

export default function TeamUpdates({ workspaceId, userId, actionRef }: {
  workspaceId: string;
  userId: string;
  actionRef: RefObject<boolean>;
}) {
  const [data, setData] = useState<TeamUpdatesData | null>(null);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const scheduleId = useRef<string | null>(null);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    const controller = new AbortController();
    void teamUpdateRequest(workspaceId, userId, undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) { setData(result); setLoadError(""); }
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load team updates.");
    });
    return () => controller.abort();
  }, [userId, version, workspaceId]);

  useEffect(() => {
    const refresh = () => setVersion(previous => previous + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function change(work: () => Promise<unknown>, success: string, refresh = true) {
    if (changing.current) return false;
    changing.current = true;
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(success);
      if (refresh) setVersion(previous => previous + 1);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the change. Try again.");
      return false;
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    const reminder = input.get("reminderMinutes");
    const followUp = input.get("followUpMinutes");
    scheduleId.current ??= crypto.randomUUID();
    const saved = await change(() => teamUpdateRequest(workspaceId, userId, {
      kind: "schedule", id: scheduleId.current, title: input.get("title"), instructions: input.get("instructions"),
      localDue: input.get("localDue"), timeZone: input.get("timeZone"), weekly: input.get("repeat") === "weekly",
      announce: input.has("announce"), reminderMinutes: reminder === "" ? null : Number(reminder),
      followUpMinutes: followUp === "" ? null : Number(followUp),
    }), "Team update scheduled.");
    if (saved) { scheduleId.current = null; form.reset(); }
  }

  function submit(roundId: string, text: string) {
    void change(() => teamUpdateRequest(workspaceId, userId, { kind: "submit", roundId, text }), "Update submitted.");
  }

  function enableNotifications() {
    void change(async () => {
      if (!publicKey || !window.isSecureContext || !("serviceWorker" in navigator) ||
        !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Open HUSH from your iPhone Home Screen or a browser that supports notifications.");
      }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications in your device settings to receive team reminders.");
      await navigator.serviceWorker.register("/hush-worker.js");
      const worker = await navigator.serviceWorker.ready;
      const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: publicKey,
      });
      await teamUpdateRequest(workspaceId, userId, { kind: "enable-notifications", subscription: subscription.toJSON() });
    }, "Team notifications enabled on this device.", false);
  }

  return (
    <section aria-labelledby="team-updates-title" className="mt-10 text-left">
      <h2 id="team-updates-title" className="text-xl font-semibold">Team updates</h2>
      {loadError && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-gray-600">{loadError}</p>
          <button type="button" className={actionButton} onClick={() => setVersion(previous => previous + 1)}>Refresh</button>
        </div>
      )}
      {!data && !loadError && <p role="status" className="mt-3 text-sm text-gray-600">Loading team updates…</p>}
      {data && publicKey && (
        <details className="mt-3 rounded-2xl border border-[#E2E6E0] p-4">
          <summary className="cursor-pointer text-sm font-medium">Team notifications on this device</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={actionButton} disabled={busy} onClick={enableNotifications}>Enable notifications</button>
            <button type="button" className={actionButton} disabled={busy} onClick={() => {
              void change(() => disableTeamNotifications(workspaceId, userId), "Team notifications disabled on this device.", false);
            }}>Disable notifications</button>
          </div>
        </details>
      )}
      {data?.canManage && (
        <details className="mt-3 rounded-2xl border border-[#E2E6E0] p-4">
          <summary className="cursor-pointer text-sm font-medium">Schedule a team update</summary>
          <form className="mt-3 space-y-4 text-sm" onChange={() => { scheduleId.current = null; }} onSubmit={schedule}>
            <label className="block">Title<input name="title" className={field} required maxLength={100} disabled={busy} /></label>
            <label className="block">Instructions<textarea name="instructions" className={field} rows={3} maxLength={1000} disabled={busy} /></label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">First deadline<input name="localDue" type="datetime-local" className={field} required disabled={busy} /></label>
              <label className="block">Time zone
                <input name="timeZone" className={field} list="team-update-zones" defaultValue={browserZone} required disabled={busy} />
                <datalist id="team-update-zones">
                  {Array.from(new Set(["UTC", browserZone, ...Intl.supportedValuesOf("timeZone")])).map(zone => <option key={zone} value={zone} />)}
                </datalist>
              </label>
              <label className="block">Repeat
                <select name="repeat" className={field} disabled={busy}><option value="once">Once</option><option value="weekly">Weekly</option></select>
              </label>
            </div>
            <fieldset className="space-y-3">
              <legend className="font-medium">Push notifications</legend>
              <label className="flex items-center gap-2"><input type="checkbox" name="announce" disabled={busy} />Notify members when scheduled</label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">Reminder (minutes before deadline)
                  <input name="reminderMinutes" type="number" min="0" max="2880" className={field} placeholder="0 = at the deadline" disabled={busy} />
                </label>
                <label className="block">Follow-up (minutes after deadline)
                  <input name="followUpMinutes" type="number" min="1" max="10080" className={field} placeholder="Only for missing updates" disabled={busy} />
                </label>
              </div>
            </fieldset>
            <button type="submit" className={actionButton} disabled={busy}>Schedule update</button>
          </form>
        </details>
      )}
      {message && <p role="status" className="mt-3 text-sm text-gray-700">{message}</p>}
      {data?.rounds.length === 0 && <p className="mt-3 text-sm text-gray-600">No team updates scheduled.</p>}
      <ul className="mt-4 space-y-3">
        {data?.rounds.map(round => (
          <li key={round.id} className="rounded-2xl border border-[#E2E6E0] p-4">
            <h3 className="font-semibold">{round.title}</h3>
            <p className="mt-1 text-sm text-gray-600">
              Due {formatDeadline(round.dueAt, round.timeZone)} ({round.timeZone}){round.weekly ? " · Weekly" : ""}
            </p>
            {round.instructions && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{round.instructions}</p>}
            {round.assigned && <p className="mt-2 text-sm font-medium">{submittedStatus(round.submittedAt, round.dueAt)}</p>}
            {round.assigned && !round.submittedAt && (
              <TeamUpdateForm workspaceId={workspaceId} userId={userId} actionRef={actionRef}
                busy={busy} onSubmit={text => submit(round.id, text)} />
            )}
            {round.update && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{round.update}</p>}
            {data.canManage && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer">{round.members.filter(member => member.submittedAt).length} of {round.members.length} updates submitted</summary>
                <ul className="mt-2 space-y-2">
                  {round.members.map((member, index) => (
                    <li className="border-t border-[#E2E6E0] pt-2" key={member.id}>
                      <p>{member.name?.trim() || `Member ${index + 1}`} · {submittedStatus(member.submittedAt, round.dueAt)}</p>
                      {member.update && <p className="mt-1 whitespace-pre-wrap break-words text-gray-600">{member.update}</p>}
                    </li>
                  ))}
                </ul>
                <button type="button" className={`${actionButton} mt-3`} disabled={busy} onClick={() => {
                  void change(() => teamUpdateRequest(workspaceId, userId, { kind: "cancel", id: round.scheduleId }), "Schedule cancelled.");
                }}>Cancel schedule</button>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
