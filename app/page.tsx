"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { disableTeamNotifications } from "@/lib/team-updates-client";
import ReminderControls from "./reminder-controls";
import TeamUpdates from "./team-updates";

type TaskDate = {
  label: "Deadline" | "Planned date";
  property: "Due" | "Date";
  start: string;
  end: string | null;
  timeZone: string | null;
};

function formatNotionDate(value: string, timeZone: string | null = null) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(dateOnly
        ? { timeZone: "UTC" }
        : { hour: "2-digit", minute: "2-digit", timeZoneName: "short",
            ...(timeZone ? { timeZone } : {}) }),
    }).format(date);
  } catch {
    return value;
  }
}

type MatchResult = {
  captureId: string;
  needsClarification: boolean;
  task: { id: string; name: string; source: string } | null;
  currentStatus: string | null;
  taskDate?: TaskDate | null;
  suggestedStatus: string | null;
  statusOptions: string[];
  reason: string;
  summary: string;
  nextStep: string;
  nextPerson: string;
  question: string;
};

type NoteFeedback = { title: string; message: string; taskId?: string };

type Delivery = {
  taskId: string;
  taskName: string;
  message: string;
  warning: boolean;
};

type SavedNote = { id: string; note_text: string; uploaded_by: string };

function SavedNotes({ workspace, userId, currentNoteId, version }: {
  workspace: { id: string; name: string };
  userId: string;
  currentNoteId: string | null;
  version: number;
}) {
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [searchText, setSearchText] = useState("");
  const [result, setResult] = useState<{
    scope: "mine" | "team";
    version: number;
    search: string;
    currentNoteId: string | null;
    notes: SavedNote[];
    message: string;
  } | null>(null);
  const teamNotes = scope === "team";
  const search = searchText.trim();
  const currentResult = result?.scope === scope && result.version === version &&
    result.search === search && result.currentNoteId === currentNoteId ? result : null;
  const notes = currentResult?.notes ?? [];
  const message = currentResult?.message ?? (search ? "Searching saved notes..." : "Loading saved notes...");

  useEffect(() => {
    const controller = new AbortController();
    const showResult = (notes: SavedNote[], message: string) => {
      if (!controller.signal.aborted) setResult({ scope, version, search, currentNoteId, notes, message });
    };
    const loadNotes = async () => {
      const { data: identity, error: identityError } = await supabase.auth.getUser();
      if (controller.signal.aborted) return;
      if (identityError || identity.user?.id !== userId) {
        showResult([], "Sign in again to view saved notes.");
        return;
      }
      const query = supabase.from("captures").select("id, note_text, uploaded_by")
        .eq("workspace_id", workspace.id).eq("file_type", "text").not("note_text", "is", null);
      if (scope === "mine") query.eq("uploaded_by", userId);
      if (currentNoteId) query.neq("id", currentNoteId);
      // PostgreSQL's ***= prefix treats the search term as literal text.
      if (search) query.regexIMatch("note_text", `***=${search}`);
      const { data, error } = await query
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .limit(search ? 100 : 3).abortSignal(controller.signal);
      if (error) throw error;
      showResult((data ?? []).filter((note): note is SavedNote => typeof note.note_text === "string"), "");
    };
    const timer = setTimeout(() => {
      void loadNotes().catch(() => showResult([], "Could not load saved notes. Please refresh to try again."));
    }, search ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [currentNoteId, scope, search, userId, version, workspace.id]);

  const changeScope = (nextScope: typeof scope) => {
    if (nextScope === scope) return;
    setResult(null);
    setScope(nextScope);
  };
  const scopeButtonClass = "rounded-full border border-black px-4 py-3 text-sm aria-pressed:bg-black aria-pressed:text-white";

  return (
    <section aria-labelledby="previous-notes-heading" className="mt-10 text-left">
      <h2 id="previous-notes-heading" className="text-xl font-semibold">Previous saved notes</h2>
      <div role="group" aria-label="Show saved notes" className="mt-4 flex flex-wrap gap-2">
        <button type="button" aria-pressed={!teamNotes} className={scopeButtonClass} onClick={() => changeScope("mine")}>
          My notes
        </button>
        <button type="button" aria-pressed={teamNotes} className={scopeButtonClass} onClick={() => changeScope("team")}>
          Team notes
        </button>
      </div>
      <p className="mt-3 text-sm text-gray-500">
        {teamNotes ? `Notes from members of ${workspace.name}.` : `Your saved notes in ${workspace.name}.`}
      </p>
      <input
        type="search"
        aria-label="Search saved notes"
        placeholder="Search saved notes"
        value={searchText}
        onChange={event => setSearchText(event.target.value)}
        className="mt-4 w-full rounded-2xl border border-[#E2E6E0] px-4 py-3 text-base"
      />
      {message && <p role="status" className="mt-4 text-sm text-gray-500">{message}</p>}
      {!message && notes.length === 0 && (
        <p role="status" className="mt-4 text-sm text-gray-500">
          {search ? "No notes match your search." : teamNotes ? "No previous team notes yet." : "No previous notes yet."}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {notes.map(note => (
          <details key={note.id} className="rounded-2xl border border-[#E2E6E0] p-4">
            <summary className="cursor-pointer truncate text-sm">{note.note_text.slice(0, 100)}</summary>
            {teamNotes && <p className="mt-3 text-xs text-gray-500">{note.uploaded_by === userId ? "Your note" : "Teammate’s note"}</p>}
            <p className="mt-3 whitespace-pre-wrap break-words text-sm text-gray-600">{note.note_text}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const actionRef = useRef(false);
  const [showLanding, setShowLanding] = useState(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [connectedWorkspace, setConnectedWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [signedInUser, setSignedInUser] = useState<{ id: string; email: string } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [showNameEditor, setShowNameEditor] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);
  const [nameMessage, setNameMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [noteText, setNoteText] = useState("");
  const [inputMode, setInputMode] = useState<"write" | "record">("write");
  const [historyVersion, setHistoryVersion] = useState(0);
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const [savedNoteText, setSavedNoteText] = useState("");
  const [clarification, setClarification] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState<NoteFeedback | null>(null);
  const [deliveryUncertain, setDeliveryUncertain] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [isPreparingRecording, setIsPreparingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [transcriptionFailed, setTranscriptionFailed] = useState(false);
  const busy = isSaving || isAnalyzing || isSending || isPreparingRecording || isRecording || isTranscribing || isSavingName;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.ondataavailable = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      transcriptionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!recording) {
      setRecordingUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(recording);
    setRecordingUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [recording]);

  const beginNewNote = () => {
    setSavedNoteId(null); setSavedNoteText(""); setMatchResult(null); setClarification("");
    setDelivery(null);
    if (!deliveryUncertain) setNoteFeedback(null);
  };

  const releaseMicrophone = () => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  const transcribeRecording = async (audio: Blob, originalName?: string) => {
    setIsTranscribing(true);
    setTranscriptionFailed(false);
    setVoiceMessage("Turning your audio into text...");
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 100000);
    try {
      if (!audio.size) throw new Error("The recording was empty. Please try again.");
      if (audio.size > 10 * 1024 * 1024) throw new Error("Please record a shorter thought under 10 MB.");
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Please sign in first.");
      if (!connectedWorkspace) throw new Error("Choose your team before recording.");
      if (!signedInUser || data.session.user.id !== signedInUser.id) {
        throw new Error("Your account changed. Sign out and sign in again before recording.");
      }
      if (!mountedRef.current) return;
      const extension = audio.type.includes("mp4") ? "mp4" : "webm";
      const form = new FormData();
      form.append("file", audio, originalName || `hush-recording.${extension}`);
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          "X-Hush-Workspace-Id": connectedWorkspace.id,
        },
        body: form,
        signal: controller.signal,
      });
      if (response.status === 413) throw new Error("This recording is too large to upload. Try a shorter recording.");
      const result = await response.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!response.ok) throw new Error([result?.message || "Could not transcribe the recording.", result?.code].filter(Boolean).join("\n"));
      if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("Could not read the transcript. Please try again.");
      setNoteText((previous) => previous.trim() ? `${previous.trim()}\n\n${result.text.trim()}` : result.text.trim());
      setVoiceMessage("Your transcript is in the note box. Review it, then save and analyze.");
    } catch (error) {
      if (!mountedRef.current) return;
      setTranscriptionFailed(true);
      setVoiceMessage(error instanceof Error && error.name !== "AbortError"
        ? error.message : "Transcription timed out. Your recording is still available below.");
    } finally {
      clearTimeout(timeout);
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null;
      actionRef.current = false;
      if (mountedRef.current) setIsTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (actionRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceMessage("Microphone recording is unavailable here. Open HUSH over HTTPS in a browser that supports recording.");
      return;
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      setVoiceMessage("This browser cannot record a supported format. Try Firefox or Chrome.");
      return;
    }
    actionRef.current = true;
    setIsPreparingRecording(true);
    setVoiceMessage("Allow microphone access to begin recording.");
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw new Error("Please sign in first.");
      if (!mountedRef.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
        }
        if (bytes > 9 * 1024 * 1024 && recorder.state === "recording") recorder.stop();
      };
      recorder.onstop = () => {
        const audio = new Blob(chunks, { type: recorder.mimeType || mimeType });
        releaseMicrophone();
        if (!mountedRef.current) return;
        setIsRecording(false);
        setRecording(audio);
        void transcribeRecording(audio);
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        if (recorder.state !== "inactive") recorder.stop();
        releaseMicrophone();
        actionRef.current = false;
        if (!mountedRef.current) return;
        setIsRecording(false);
        setVoiceMessage("The recording stopped unexpectedly. Please try again.");
      };
      beginNewNote();
      recorder.start(1000);
      setRecording(null);
      setTranscriptionFailed(false);
      setIsRecording(true);
      setVoiceMessage("Recording. Speak naturally, then press Stop recording. Maximum 2 minutes for this test.");
      recordingTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 120000);
    } catch (error) {
      releaseMicrophone();
      actionRef.current = false;
      if (!mountedRef.current) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      setVoiceMessage(denied
        ? "Microphone access was denied. Allow microphone access in your browser, then try again."
        : error instanceof Error ? error.message : "Could not start recording. Please try again.");
    } finally {
      if (mountedRef.current) setIsPreparingRecording(false);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  };

  const notionLink = (id: string) =>
    `https://www.notion.so/${id.replace(/-/g, "")}`;

  const openWorkspace = async (withPassword = false) => {
    if (isSigningIn || actionRef.current) return;
    if (!withPassword && signedInUser) { setShowLanding(false); return; }
    actionRef.current = true;
    setIsSigningIn(true);
    try {
      if (withPassword) {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(), password,
        });
        if (error) throw error;
        setPassword("");
      } else {
        const { data } = await supabase.auth.getSession();
        if (!data.session) return;
      }
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        if (!withPassword) return;
        throw new Error("Please sign in again.");
      }
      const { data: teams, error: workspaceError } = await supabase
        .from("workspaces").select("id, name").order("name");
      if (workspaceError) throw new Error("We couldn't load your teams. Please try again.");
      const metadata = userData.user.user_metadata ?? {};
      let storedName = [metadata.hush_display_name, metadata.full_name, metadata.name]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?.trim().replace(/\s+/g, " ").slice(0, 80) || "";
      const enteredName = withPassword ? nameDraft.trim().replace(/\s+/g, " ") : "";
      if (enteredName) {
        if (enteredName.length > 80) throw new Error("Use a name under 80 characters.");
        const { data: updated, error: nameError } = await supabase.auth.updateUser({
          data: { hush_display_name: enteredName },
        });
        if (nameError) throw nameError;
        if (updated.user?.id !== userData.user.id || updated.user.user_metadata?.hush_display_name !== enteredName) {
          throw new Error("We couldn't save your name. Please try signing in again.");
        }
        storedName = enteredName;
      }
      setDisplayName(storedName);
      setNameDraft(storedName);
      setShowNameEditor(!storedName);
      setNameMessage("");
      const { data: currentSession } = await supabase.auth.getSession();
      if (currentSession.session?.user.id !== userData.user.id) throw new Error("Your account changed. Please sign in again.");
      const available = (teams ?? []).map(team => ({ id: team.id, name: team.name || "Your workspace" }));
      setSignedInUser({ id: userData.user.id, email: userData.user.email || "" });
      setWorkspaces(available);
      setConnectedWorkspace(available.length === 1 ? available[0] : null);
    } catch (error) {
      alert(error instanceof Error ? error.message : "We couldn't sign you in. Please try again.");
    } finally {
      actionRef.current = false;
      setIsSigningIn(false);
      setShowLanding(false);
    }
  };

  const saveDisplayName = async () => {
    if (actionRef.current) return;
    const name = nameDraft.trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) {
      setNameMessage("Enter the name you'd like your team to see, up to 80 characters.");
      return;
    }
    actionRef.current = true;
    setIsSavingName(true);
    setNameMessage("");
    try {
      const { data: current, error: userError } = await supabase.auth.getUser();
      if (userError || !current.user) throw new Error("Please sign in again before saving your name.");
      const { data, error } = await supabase.auth.updateUser({
        data: { hush_display_name: name },
      });
      if (error) throw error;
      if (data.user?.id !== current.user.id || data.user.user_metadata?.hush_display_name !== name) {
        throw new Error("We couldn't confirm that your name was saved. Please try again.");
      }
      setDisplayName(name);
      setNameDraft(name);
      setShowNameEditor(false);
      setNameMessage("Your name is saved for future updates.");
    } catch (error) {
      setNameMessage(error instanceof Error ? error.message : "We couldn't save your name. Please try again.");
    } finally {
      actionRef.current = false;
      setIsSavingName(false);
    }
  };

  const persistNote = async (text: string): Promise<string> => {
    if (!text.trim()) throw new Error("Write a thought first.");
    if (text.length > 1800) {
      throw new Error("For this test, keep the note and added context under 1800 characters.");
    }
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) throw new Error("Please sign in first.");
    if (!signedInUser || userData.user.id !== signedInUser.id) {
      throw new Error("Your account changed. Sign out and sign in again before saving.");
    }
    if (!connectedWorkspace) throw new Error("Choose your team before saving.");
    const { data: workspace, error: workspaceError } = await supabase
      .from("workspaces").select("id").eq("id", connectedWorkspace.id).maybeSingle();
    if (workspaceError) throw new Error("We couldn't check your team. Check your connection and try again.");
    if (!workspace) throw new Error("You no longer have access to this team. Ask your team administrator to check your membership.");
    const { data, error } = await supabase.from("captures").insert({
      workspace_id: workspace.id,
      uploaded_by: userData.user.id,
      file_type: "text",
      note_text: text.trim(),
      file_path: null,
    }).select("id").single();
    if (error?.code === "42501") throw new Error("This account can't save notes in this team. Ask your team administrator to check your access.");
    if (error?.code === "23503") throw new Error("HUSH couldn't verify your profile or team. Ask your team administrator to check your account.");
    if (error || !data) throw new Error("HUSH couldn't confirm the save. Your draft is still here. Check Previous saved notes before trying again.");
    return data.id;
  };

  const requestAnalysis = async (captureId: string) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Please sign in first.");
    const response = await fetch("/api/match-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session.access_token}`,
      },
      body: JSON.stringify({ captureId }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(typeof result?.message === "string" ? result.message : "Could not analyze the note. Please try again.");
    }
    if (result?.captureId !== captureId) throw new Error("HUSH couldn't confirm the analysis. Select Analyze note to try again.");
    setMatchResult(result);
  };

  const reportNoteError = (title: string, error: unknown, fallback: string) => {
    setNoteFeedback({ title, message: error instanceof Error && !(error instanceof TypeError) ? error.message : fallback });
  };

  function reportUncertainDelivery(taskId: string) {
    setDeliveryUncertain(true);
    setNoteFeedback({
      title: "Delivery not confirmed",
      message: "Open the task in Notion and look for your HUSH update. Don't send the same update again while its delivery is unclear.",
      taskId,
    });
  }

  const saveNote = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setIsSaving(true);
    setNoteFeedback(null);
    try {
      const text = noteText.trim();
      const id = await persistNote(text);
      setSavedNoteId(id);
      setSavedNoteText(text);
      setHistoryVersion(value => value + 1);
      setMatchResult(null);
      setClarification("");
      setDeliveryUncertain(false);
      setDelivery(null);
      setNoteText("");
    } catch (error) {
      setHistoryVersion(value => value + 1);
      reportNoteError("Save not confirmed", error, "Your draft is still here. Check Previous saved notes before trying again.");
    } finally {
      actionRef.current = false;
      setIsSaving(false);
    }
  };

  const analyzeNote = async () => {
    if (!savedNoteId || actionRef.current || deliveryUncertain) return;
    actionRef.current = true;
    setIsAnalyzing(true);
    setNoteFeedback(null);
    setMatchResult(null);
    setClarification("");
    try {
      await requestAnalysis(savedNoteId);
    } catch (error) {
      reportNoteError("Analysis couldn't finish", error, "Your note is saved. Try Analyze note again.");
    } finally {
      actionRef.current = false;
      setIsAnalyzing(false);
    }
  };

  const clarifyAndAnalyze = async () => {
    if (actionRef.current || deliveryUncertain || !savedNoteId ||
        !matchResult?.needsClarification || matchResult.captureId !== savedNoteId) return;
    const answer = clarification.trim();
    if (!answer) {
      setNoteFeedback({ title: "Add more context", message: "Enter an answer before analyzing again." });
      return;
    }
    const updatedText = `${savedNoteText}\n\nClarification question: ${matchResult.question}\nUser answer: ${answer}`;
    if (updatedText.length > 1800) {
      setNoteFeedback({ title: "Context is too long", message: "Keep the note and your answer under 1,800 characters in total. Shorten your answer or write a new note." });
      return;
    }
    actionRef.current = true;
    setIsAnalyzing(true);
    setNoteFeedback(null);
    let contextSaved = false;
    try {
      const id = await persistNote(updatedText);
      contextSaved = true;
      setSavedNoteId(id);
      setSavedNoteText(updatedText);
      setHistoryVersion(value => value + 1);
      setMatchResult(null);
      setClarification("");
      await requestAnalysis(id);
    } catch (error) {
      if (!contextSaved) setHistoryVersion(value => value + 1);
      reportNoteError(contextSaved ? "Analysis couldn't finish" : "Context not confirmed", error,
        contextSaved ? "Your updated note is saved. Try Analyze note again." : "Your answer is still here. Check Previous saved notes before trying again.");
    } finally {
      actionRef.current = false;
      setIsAnalyzing(false);
    }
  };

  const sendUpdate = async () => {
    if (actionRef.current || deliveryUncertain || !savedNoteId ||
        !matchResult?.task || matchResult.needsClarification ||
        matchResult.captureId !== savedNoteId) return;
    if (!displayName.trim()) {
      setShowNameEditor(true);
      setNameMessage("Save your name before sharing this update with your team.");
      return;
    }
    actionRef.current = true;
    setIsSending(true);
    setNoteFeedback(null);
    let requestStarted = false;
    const selectedTask = matchResult.task;
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Please sign in first.");
      requestStarted = true;
      const response = await fetch("/api/notion-update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({
          captureId: savedNoteId, taskId: selectedTask.id,
          summary: matchResult.summary, nextStep: matchResult.nextStep,
          nextPerson: matchResult.nextPerson,
          currentStatus: matchResult.currentStatus,
          suggestedStatus: matchResult.suggestedStatus, confirmed: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        const uncertain = result.deliveryUncertain === true || (response.status >= 500 && result.deliveryUncertain !== false);
        if (uncertain) {
          reportUncertainDelivery(typeof result.taskId === "string" ? result.taskId : selectedTask.id);
        } else {
          if (response.status === 409) setMatchResult(null);
          setNoteFeedback({
            title: "Update wasn't sent",
            message: result.message || "Your note is still saved. Review the update and try again.",
          });
        }
        return;
      }
      if (result.delivered !== true) {
        reportUncertainDelivery(selectedTask.id);
        return;
      }
      const deliveredTaskId = typeof result.taskId === "string" ? result.taskId : selectedTask.id;
      setDelivery({ taskId: deliveredTaskId,
        taskName: deliveredTaskId.replace(/-/g, "").toLowerCase() === selectedTask.id.replace(/-/g, "").toLowerCase()
          ? selectedTask.name : "Previously selected task",
        message: result.message || "Update sent to Notion.", warning: result.warning === true });
      setSavedNoteId(null);
      setSavedNoteText("");
      setMatchResult(null);
      setClarification("");
    } catch (error) {
      if (requestStarted) {
        reportUncertainDelivery(selectedTask.id);
      } else reportNoteError("Update wasn't sent", error, "Sign in again and retry.");
    } finally {
      actionRef.current = false;
      setIsSending(false);
    }
  };

  if (showLanding) return (
    <main className="min-h-screen bg-white text-black" style={{ fontFamily: "Arial, sans-serif" }}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div className="text-2xl font-bold tracking-[-0.06em]">hush<span className="text-[#93B5A0]">.</span></div>
          <nav aria-label="Main navigation" className="flex items-center gap-5 text-xs sm:gap-8">
            <a href="#how-to-use" className="text-gray-600 hover:text-black">How to use</a>
            <button type="button" disabled={isSigningIn} onClick={() => void openWorkspace()}
              className="rounded-full border border-black px-4 py-2">Connect workspace</button>
          </nav>
        </header>

        <section className="grid items-center gap-12 py-20 md:grid-cols-2 md:gap-14 md:py-28">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-gray-500">A little less admin for your team</p>
            <h1 className="mt-5 text-5xl font-semibold leading-[1.02] tracking-[-0.06em] sm:text-6xl">
              Your work, in your own words.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-gray-600">
              Tell HUSH what you&apos;ve been working on by recording a quick voice note or writing a few lines in any of the supported languages. HUSH finds the relevant Notion task and prepares an English update for your team.
            </p>
            <p className="mt-3 text-sm text-gray-500">You can check the wording, choose a status and decide when it&apos;s ready to share.</p>
            <button type="button" disabled={isSigningIn} onClick={() => void openWorkspace()}
              className="mt-8 rounded-full bg-black px-7 py-4 text-sm font-medium text-white">
              Connect your workspace
            </button>
            <p className="mt-3 text-xs text-gray-500">Sign in with your team account to open its connected workspace.</p>
          </div>

          <div className="py-4 md:pl-4">
            <p className="text-xs uppercase tracking-[0.14em] text-gray-500">What that looks like</p>
            <p className="mt-6 text-xl leading-relaxed tracking-[-0.02em]">
              &ldquo;I&apos;ve started the launch announcement and pulled together some references. I&apos;ll share a draft with the team tomorrow.&rdquo;
            </p>
            <div className="mt-6 border-t border-[#E2E6E0] pt-6">
              <p className="text-xs text-gray-500">Suggested task</p>
              <h2 className="mt-2 text-lg font-semibold">Launch announcement</h2>
              <p className="mt-5 text-xs text-gray-500">Team update</p>
              <p className="mt-2 text-sm leading-relaxed">The launch announcement is underway, with references collected and a first draft planned for the team tomorrow.</p>
              <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-[#D9DDD8] px-3 py-2">Idea</span>
                <span aria-label="changes to">→</span>
                <span className="rounded-full bg-[#EDF2EE] px-3 py-2">Drafting</span>
              </div>
              <p className="mt-5 text-xs text-gray-500">The task and status are suggestions until you confirm them.</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="languages-heading" className="border-t border-[#E2E6E0] py-8">
          <h2 id="languages-heading" className="text-xs font-semibold uppercase tracking-[0.14em]">A shared language for your team</h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-gray-600">
            You can speak or write in English, French, German, Italian, Spanish, Swedish or Turkish. HUSH prepares your update in English so everyone on your team can follow along without you having to translate it.
          </p>
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-gray-500">
            Voice notes are transcribed first, and language recognition can vary. You can check and edit the transcript before saving it.
          </p>
        </section>

        <section id="how-to-use" className="scroll-mt-8 border-t border-[#E2E6E0] py-10">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em]">How to use</h2>
          <ol className="mt-5 grid gap-4 text-sm text-gray-600 sm:grid-cols-3">
            <li><span className="mr-2 text-black">01</span>Tell HUSH what you&apos;ve been working on.</li>
            <li><span className="mr-2 text-black">02</span>Save your note and let HUSH find the task.</li>
            <li><span className="mr-2 text-black">03</span>Check the update and status before sharing it.</li>
          </ol>
        </section>
        <footer className="border-t border-[#E2E6E0] py-6 text-center text-xs text-[#626A62]">Kayra Irmak Tan, 2026</footer>
      </div>
    </main>
  );

  if (!connectedWorkspace && signedInUser) return (
    <main className="flex min-h-screen items-center justify-center bg-white text-black" style={{ fontFamily: "Arial, sans-serif" }}>
      <div className="w-full max-w-sm px-6">
        <h1 className="text-3xl font-bold">{workspaces.length ? "Choose your team" : "No team yet"}</h1>
        <p className="mt-4 break-words text-sm text-gray-500">Signed in as {signedInUser.email}</p>
        <p className="mt-2 text-sm text-gray-500">{workspaces.length ? "Your note will use this team's Notion task lists." : "Ask your team administrator to add this account, then sign in again."}</p>
        <div className="mt-6 space-y-3">
          {workspaces.map(team => <button key={team.id} type="button" disabled={isSigningIn} onClick={() => setConnectedWorkspace(team)}
            className="block w-full rounded-xl border border-black px-5 py-4 text-left">{team.name}</button>)}
        </div>
        <button type="button" className="mt-6 text-sm text-gray-500" onClick={async () => {
          if (actionRef.current) return;
          actionRef.current = true;
          setIsSigningIn(true);
          try {
            if (signedInUser && workspaces[0]) {
              await disableTeamNotifications(workspaces[0].id, signedInUser.id).catch(() => {});
            }
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
            setSignedInUser(null); setWorkspaces([]); setDisplayName(""); setNameDraft(""); setPassword("");
          } catch { alert("Could not sign out. Please try again."); }
          finally { actionRef.current = false; setIsSigningIn(false); }
        }}>Sign out</button>
      </div>
    </main>
  );

  if (!connectedWorkspace) return (
    <main className="flex min-h-screen items-center justify-center bg-black text-white"
      style={{ fontFamily: "Arial, sans-serif" }}>
      <div className="w-full max-w-sm px-6 text-center">
        <button type="button" onClick={() => setShowLanding(true)} className="mb-8 text-xs text-gray-400 hover:text-white">Back to HUSH</button>
        <h1 className="text-3xl font-bold">Connect your workspace</h1>
        <p className="mt-4 text-sm leading-relaxed text-gray-400">
          Sign in with your team account to open its connected Notion workspace.
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void openWorkspace(true); }}>
          <label htmlFor="sign-in-name" className="mt-6 block text-left text-sm">Name</label>
          <input id="sign-in-name" type="text" autoComplete="given-name" placeholder="e.g. Kayra or Neyzen"
            maxLength={80} disabled={isSigningIn} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)}
            className="mx-auto mt-2 block w-full border border-white bg-black px-4 py-3 text-white" />
          <p className="mt-2 text-left text-xs leading-relaxed text-gray-400">Your first name is enough. If you've already saved one, you can leave this blank.</p>
          <input type="email" autoComplete="email" aria-label="Email" placeholder="Email" required
            disabled={isSigningIn} value={email} onChange={(event) => setEmail(event.target.value)}
            className="mx-auto mt-6 block w-full border border-white bg-black px-4 py-3 text-white" />
          <input type="password" autoComplete="current-password" aria-label="Password" placeholder="Password" required
            disabled={isSigningIn} value={password} onChange={(event) => setPassword(event.target.value)}
            className="mx-auto mt-3 block w-full border border-white bg-black px-4 py-3 text-white" />
          <div className="mt-3 text-right">
            <Link href="/forgot-password" className="text-sm text-gray-300 underline hover:text-white">Forgot password?</Link>
          </div>
          <button type="submit" disabled={isSigningIn}
            className="mx-auto mt-4 block rounded-full bg-white px-6 py-3 text-black disabled:opacity-50">
            {isSigningIn ? "Opening your workspace..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );

  return (
    <main className="min-h-screen bg-white text-black" style={{ fontFamily: "Arial, sans-serif" }}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <button type="button" onClick={() => setShowLanding(true)} disabled={busy}
            aria-label="HUSH home" className="text-2xl font-bold tracking-[-0.06em] disabled:opacity-50">hush<span className="text-[#93B5A0]">.</span></button>
          <div className="flex flex-wrap items-center gap-4">
            <details className="relative text-xs">
              <summary className="cursor-pointer text-gray-500">How to use</summary>
              <p className="absolute right-0 z-10 mt-3 w-60 rounded-xl border border-[#E2E6E0] bg-white p-4 leading-relaxed shadow-sm">
                Record or write a note, save it and choose Analyze. Check the suggested task, update and status, then confirm when you&apos;re happy with them.
              </p>
            </details>
            <span className="text-xs text-gray-500">{signedInUser?.email}</span>
            {process.env.NODE_ENV === "development" && (
              <a href={`/team-invites?team=${encodeURIComponent(connectedWorkspace.id)}`}
                target="_blank" rel="noopener noreferrer" className="text-xs underline">Team invitations</a>
            )}
            <div className="rounded-full border border-[#D9DDD8] px-4 py-2 text-xs">{connectedWorkspace.name}</div>
            {workspaces.length > 1 && <button type="button" disabled={busy} className="text-xs text-gray-500 disabled:opacity-50" onClick={() => {
              if (actionRef.current) return;
              if ((noteText.trim() || savedNoteId || recording || deliveryUncertain) &&
                !window.confirm("Switch teams and clear this note? If delivery was uncertain, check the Notion task before sending it again.")) return;
              setNoteText(""); setSavedNoteId(null); setSavedNoteText(""); setMatchResult(null);
              setClarification(""); setDelivery(null); setNoteFeedback(null); setDeliveryUncertain(false); setRecording(null);
              setVoiceMessage(""); setTranscriptionFailed(false); setConnectedWorkspace(null);
            }}>Switch team</button>}
            <button type="button" disabled={busy} onClick={() => {
              setNameDraft(displayName);
              setNameMessage("");
              setShowNameEditor(true);
            }} className="rounded-full border border-[#D9DDD8] px-4 py-2 text-xs disabled:opacity-50">
              {displayName ? `Name: ${displayName}` : "Add your name"}
            </button>
            <button type="button" disabled={busy} className="text-xs text-gray-500 disabled:opacity-50" onClick={async () => {
              if (actionRef.current) return;
              actionRef.current = true;
              try {
                if (signedInUser) await disableTeamNotifications(connectedWorkspace.id, signedInUser.id).catch(() => {});
                const { error } = await supabase.auth.signOut();
                if (error) throw error;
                setConnectedWorkspace(null);
                setSignedInUser(null);
                setWorkspaces([]);
                setDisplayName("");
                setNameDraft("");
                setShowNameEditor(false);
                setNameMessage("");
                setNoteText("");
                setSavedNoteId(null);
                setSavedNoteText("");
                setMatchResult(null);
                setClarification("");
                setDelivery(null);
                setNoteFeedback(null);
                setDeliveryUncertain(false);
                setRecording(null);
                setVoiceMessage("");
                setPassword("");
                setShowLanding(true);
              } catch { alert("We couldn't sign you out. Please try again."); }
              finally { actionRef.current = false; }
            }}>Sign out</button>
          </div>
        </header>
        {showNameEditor && (
          <section aria-labelledby="name-heading" className="mx-auto mt-8 max-w-2xl rounded-2xl border border-[#D9DDD8] p-5">
            <h2 id="name-heading" className="text-lg font-semibold">What name should your team see?</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              We'll add this name to the updates you share in Notion, alongside your account email. It won't change who owns a task.
            </p>
            <form onSubmit={(event) => { event.preventDefault(); void saveDisplayName(); }} className="mt-4">
              <label htmlFor="display-name" className="block text-sm">Your name</label>
              <input id="display-name" type="text" autoComplete="name" value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)} maxLength={80} required disabled={busy}
                placeholder="Your full name" className="mt-2 w-full rounded-lg border border-black bg-white px-4 py-3 text-black disabled:opacity-50" />
              <div className="mt-4 flex items-center gap-4">
                <button type="submit" disabled={busy || !nameDraft.trim()} className="rounded-full bg-black px-5 py-3 text-sm text-white disabled:opacity-50">
                  {isSavingName ? "Saving..." : "Save name"}
                </button>
                {displayName && <button type="button" disabled={busy} onClick={() => {
                  setShowNameEditor(false); setNameDraft(displayName); setNameMessage("");
                }} className="text-sm text-gray-500 disabled:opacity-50">Cancel</button>}
              </div>
            </form>
          </section>
        )}
        {nameMessage && <p role="status" className="mx-auto mt-4 max-w-2xl text-sm text-gray-600">{nameMessage}</p>}
        <section className="mx-auto max-w-2xl pt-28 pb-20 text-center">
          <h1 className="text-5xl font-semibold tracking-[-0.06em] md:text-6xl">What&apos;s on your mind?</h1>
          <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-[#626A62]">
            Tell us what you&apos;ve been working on, or write it down, and we&apos;ll help find the right task.
          </p>
          <div className="mt-12 rounded-[32px] border border-[#E2E6E0] bg-white p-8 shadow-sm">
            <h2 className="mt-6 text-xl font-semibold">What would you like your team to know?</h2>
            <p className="mt-3 text-sm text-gray-500">Choose how you want to add your note.</p>
            <div role="group" aria-label="How to add your note" className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" aria-pressed={inputMode === "write"} disabled={busy}
                onClick={() => setInputMode("write")}
                className={`rounded-2xl border px-4 py-5 text-left disabled:opacity-50 ${inputMode === "write" ? "border-black bg-black text-white" : "border-[#D9DDD8]"}`}>
                <span className="block font-semibold">Write a note</span>
                <span className="mt-1 block text-xs">Type in your own words</span>
              </button>
              <button type="button" aria-pressed={inputMode === "record"} disabled={busy}
                onClick={() => setInputMode("record")}
                className={`rounded-2xl border px-4 py-5 text-left disabled:opacity-50 ${inputMode === "record" ? "border-black bg-black text-white" : "border-[#D9DDD8]"}`}>
                <span className="block font-semibold">Record a voice note</span>
                <span className="mt-1 block text-xs">Speak, then review the transcript</span>
              </button>
            </div>
            {inputMode === "record" && <div>
              <p className="mt-5 text-sm text-gray-500">Press Record, allow microphone access, then speak. Press Stop when you finish.</p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <button type="button" onClick={isRecording ? stopRecording : startRecording}
                disabled={!isRecording && busy}
                className="rounded-full bg-black px-7 py-4 font-medium text-white disabled:opacity-50">
                {isRecording ? "Stop recording" : isPreparingRecording ? "Opening microphone..." : isTranscribing ? "Transcribing..." : "Record a thought"}
              </button>
            </div>
            {voiceMessage && <p role="status" className="mt-4 whitespace-pre-wrap text-sm">{voiceMessage}</p>}
            {recordingUrl && <div className="mt-4 rounded-xl bg-gray-50 p-4 text-left">
              <p className="text-sm font-semibold">Your recording</p>
              <audio controls src={recordingUrl} className="mt-3 w-full" />
              <a href={recordingUrl} download={recording instanceof File ? recording.name : `hush-recording.${recording?.type.includes("mp4") ? "mp4" : "webm"}`}
                className="mt-3 inline-block text-sm underline">Download recording</a>
              {transcriptionFailed && <button type="button" disabled={busy} onClick={() => {
                if (!recording || actionRef.current) return;
                actionRef.current = true;
                void transcribeRecording(recording, recording instanceof File ? recording.name : undefined);
              }} className="mt-3 ml-4 rounded-full border border-black px-4 py-2 text-sm disabled:opacity-50">Try transcription again</button>}
            </div>}
            </div>}
            <label htmlFor="note-text" className="mt-6 block text-left text-sm font-semibold">
              {inputMode === "record" ? "Review or edit your transcript" : "Your note"}
            </label>
            <textarea id="note-text" aria-label="Your note" placeholder={inputMode === "record" ? "Your transcript will appear here after recording..." : "Write a thought..."} value={noteText}
              disabled={busy} onChange={(event) => { beginNewNote(); setNoteText(event.target.value); }} maxLength={1800} rows={4}
              className="mt-6 w-full border border-black bg-white p-4 text-black disabled:opacity-50" />
            {noteText.length > 1800 && <p role="status" className="mt-2 text-left text-sm">
              This transcript is {noteText.length} characters long. Shorten it to 1800 characters before saving. The full transcript is kept in the box.
            </p>}
            <button type="button" onClick={saveNote} disabled={busy || !noteText.trim() || noteText.length > 1800}
              className="mt-3 rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">
              {isSaving ? "Saving..." : "Save note"}
            </button>
            {savedNoteId && (
              <button type="button" disabled={busy || deliveryUncertain} onClick={analyzeNote}
                className="mt-3 ml-3 rounded-full border border-black px-6 py-3 text-black disabled:opacity-50">
                {isAnalyzing ? "Finding the right task..." : "Analyze note"}
              </button>
            )}
            {noteFeedback && (
              <div role="alert" className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-left text-amber-950">
                <p className="font-semibold">{noteFeedback.title}</p>
                <p className="mt-2 text-sm">{noteFeedback.message}</p>
                {noteFeedback.taskId && <a href={notionLink(noteFeedback.taskId)} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm underline">Check task in Notion</a>}
              </div>
            )}
            {delivery && (
              <div role="status" className="mt-6 rounded-2xl border border-black p-5 text-left">
                <p className="font-semibold">{delivery.warning ? "Sent to Notion — check details" : "Sent to Notion"}</p>
                <p className="mt-2">{delivery.taskName}</p>
                <p className="mt-2 text-sm">{delivery.message}</p>
                <a href={notionLink(delivery.taskId)} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm underline">Open task in Notion</a>
              </div>
            )}
            {savedNoteId && (
              <div className="mt-6 rounded-2xl bg-gray-50 p-4 text-left">
                <p className="text-sm font-semibold">Current saved note{deliveryUncertain ? " — check delivery" : matchResult ? "" : " — ready to analyze"}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm">{savedNoteText}</p>
              </div>
            )}
            {matchResult && matchResult.captureId === savedNoteId && (
              <div aria-live="polite" className="mt-6 rounded-2xl border border-black p-6 text-left">
                {matchResult.needsClarification ? (
                  <>
                    <h3 className="text-lg font-semibold">A little more context</h3>
                    <p className="mt-3">{matchResult.question}</p>
                    <label htmlFor="clarification" className="mt-5 block text-sm font-semibold">Your answer</label>
                    <textarea id="clarification" value={clarification} disabled={busy}
                      onChange={(event) => setClarification(event.target.value)}
                      placeholder="Tell us a little more about the work you mean." rows={3} maxLength={1800}
                      className="mt-2 w-full rounded-lg border border-black bg-white p-3 text-black disabled:opacity-50" />
                    <button type="button" onClick={clarifyAndAnalyze}
                      disabled={busy || deliveryUncertain || !clarification.trim()}
                      className="mt-3 rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">
                      {isAnalyzing ? "Finding the right task..." : "Add context & analyze"}
                    </button>
                    <p className="mt-3 text-sm text-gray-500">We&apos;ll keep your answer with the note and use it to find the right task. You&apos;ll still review the update before sending it.</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-gray-500">Suggested task</p>
                    <h3 className="mt-2 text-lg font-semibold">{matchResult.task?.name}</h3>
                    <p className="mt-2 text-sm text-gray-600">{matchResult.reason}</p>
                    <p className="mt-3 text-xs text-gray-500">
                      {displayName ? `Posted by: ${displayName}` : "Add your name above before sending this update."}
                    </p>
                    <div className="mt-5 border-b border-[#E2E6E0] pb-5">
                      <p className="text-sm font-semibold">{matchResult.taskDate?.label || "Task date"}</p>
                      {matchResult.taskDate ? (
                        <>
                          <p className="mt-2 text-sm">
                            {formatNotionDate(matchResult.taskDate.start, matchResult.taskDate.timeZone)}
                            {matchResult.taskDate.end && matchResult.taskDate.end !== matchResult.taskDate.start
                              ? ` – ${formatNotionDate(matchResult.taskDate.end, matchResult.taskDate.timeZone)}` : ""}
                          </p>
                          <p className="mt-2 text-xs text-gray-500">
                            {matchResult.taskDate.property === "Due"
                              ? "This is the deadline currently saved in Notion."
                              : "This is the date currently saved in Notion. It may be a planned date rather than a deadline."}
                          </p>
                        </>
                      ) : <p className="mt-2 text-sm text-gray-500">No date is set for this task in Notion.</p>}
                      {signedInUser && matchResult.task && (
                        <ReminderControls key={matchResult.captureId} workspaceId={connectedWorkspace.id} userId={signedInUser.id}
                          task={{ id: matchResult.task.id, captureId: matchResult.captureId }} initialTime={matchResult.taskDate?.start} />
                      )}
                    </div>
                    <p className="mt-5 font-semibold">Update</p>
                    <p className="mt-1 whitespace-pre-wrap">{matchResult.summary}</p>
                    {matchResult.nextStep && <><p className="mt-4 font-semibold">Next step</p><p className="mt-1">{matchResult.nextStep}</p></>}
                    {matchResult.nextPerson && <><p className="mt-4 font-semibold">Next person</p><p className="mt-1">{matchResult.nextPerson}</p></>}
                    <div className="mt-5 rounded-xl bg-gray-50 p-4">
                      <p className="font-semibold">Status</p>
                      <p className="mt-2 text-sm">Current: {matchResult.currentStatus || "Not set"}</p>
                      <label htmlFor="suggested-status" className="mt-3 block text-sm">Status after confirmation</label>
                      <select id="suggested-status" value={matchResult.suggestedStatus ?? ""}
                        disabled={busy || deliveryUncertain} onChange={(event) => {
                          const value = event.target.value;
                          setMatchResult((previous) => previous ? { ...previous, suggestedStatus: value || null } : null);
                        }} className="mt-2 w-full rounded-lg border border-black bg-white px-3 py-3 text-black">
                        <option value="">Keep current status</option>
                        {matchResult.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                      </select>
                      <p className="mt-3 text-sm">
                        {matchResult.suggestedStatus && matchResult.suggestedStatus !== matchResult.currentStatus
                          ? `${matchResult.currentStatus || "Not set"} → ${matchResult.suggestedStatus}` : "Status will stay the same."}
                      </p>
                    </div>
                    <button type="button" onClick={sendUpdate} disabled={busy || deliveryUncertain}
                      className="mt-6 rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">
                      {isSending ? "Sending..." : "Confirm & send"}
                    </button>
                  </>
                )}
                <p className="mt-5 text-sm text-gray-500">
                  Your team will see the English update with your name or account email and the time you shared it. Your original note stays in HUSH.
                </p>
                {matchResult.task && <a href={notionLink(matchResult.task.id)} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm underline">Open task in Notion</a>}
              </div>
            )}

          </div>
          {signedInUser && (
            <SavedNotes key={`${connectedWorkspace.id}:${signedInUser.id}`} workspace={connectedWorkspace}
              userId={signedInUser.id} currentNoteId={savedNoteId} version={historyVersion} />
          )}
          {signedInUser && <TeamUpdates key={`updates:${connectedWorkspace.id}:${signedInUser.id}`}
            workspaceId={connectedWorkspace.id} userId={signedInUser.id} />}
          {signedInUser && <ReminderControls key={connectedWorkspace.id} workspaceId={connectedWorkspace.id} userId={signedInUser.id} />}
        </section>
        <footer className="border-t border-[#E2E6E0] py-6 text-center text-xs text-[#626A62]">Kayra Irmak Tan, 2026</footer>
      </div>
    </main>
  );
}
