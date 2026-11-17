"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { supabase } from "@/lib/supabase";

type VoiceRecordingOptions = {
  workspaceId?: string;
  userId?: string;
  actionRef: RefObject<boolean>;
  onRecordingStart?: () => void;
  onTranscript: (text: string) => void;
  transcriptMessage: string;
};

export function useVoiceRecording({
  workspaceId, userId, actionRef, onRecordingStart, onTranscript, transcriptMessage,
}: VoiceRecordingOptions) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [isPreparingRecording, setIsPreparingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recording, setRecordedAudio] = useState<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [transcriptionFailed, setTranscriptionFailed] = useState(false);

  const ownsAction = useRef(false);
  const recordingUrlRef = useRef("");

  const acquireAction = () => {
    ownsAction.current = true;
    actionRef.current = true;
  };

  const releaseAction = useCallback(() => {
    if (!ownsAction.current) return;
    ownsAction.current = false;
    actionRef.current = false;
  }, [actionRef]);

  const setRecording = (audio: Blob | null) => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = audio ? URL.createObjectURL(audio) : "";
    setRecordingUrl(recordingUrlRef.current);
    setRecordedAudio(audio);
  };

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
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      releaseAction();
    };
  }, [releaseAction]);

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
      if (!workspaceId) throw new Error("Choose your team before recording.");
      if (data.session.user.id !== userId) {
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
          "X-Hush-Workspace-Id": workspaceId,
        },
        body: form,
        signal: controller.signal,
      });
      if (response.status === 413) throw new Error("This recording is too large to upload. Try a shorter recording.");
      const result = await response.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!response.ok) throw new Error([result?.message || "Could not transcribe the recording.", result?.code].filter(Boolean).join("\n"));
      if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("Could not read the transcript. Please try again.");
      onTranscript(result.text.trim());
      setVoiceMessage(transcriptMessage);
    } catch (error) {
      if (!mountedRef.current) return;
      setTranscriptionFailed(true);
      setVoiceMessage(error instanceof Error && error.name !== "AbortError"
        ? error.message : "Transcription timed out. Your recording is still available below.");
    } finally {
      clearTimeout(timeout);
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null;
      releaseAction();
      if (mountedRef.current) setIsTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (actionRef.current) {
      setVoiceMessage("Finish the current action before recording.");
      return;
    }
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
    acquireAction();
    setIsPreparingRecording(true);
    setVoiceMessage("Allow microphone access to begin recording.");
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || data.user?.id !== userId) throw new Error("Please sign in first.");
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
        releaseAction();
        if (!mountedRef.current) return;
        setIsRecording(false);
        setVoiceMessage("The recording stopped unexpectedly. Please try again.");
      };
      onRecordingStart?.();
      recorder.start(1000);
      setRecording(null);
      setTranscriptionFailed(false);
      setIsRecording(true);
      setVoiceMessage("Recording. Speak naturally, then press Stop recording. Maximum 2 minutes.");
      recordingTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 120000);
    } catch (error) {
      releaseMicrophone();
      releaseAction();
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

  const retryTranscription = () => {
    if (!recording || actionRef.current) return;
    acquireAction();
    void transcribeRecording(recording, recording instanceof File ? recording.name : undefined);
  };

  const resetRecording = () => {
    setRecording(null);
    setVoiceMessage("");
    setTranscriptionFailed(false);
  };

  return {
    isPreparingRecording, isRecording, isTranscribing, recording, recordingUrl,
    voiceMessage, transcriptionFailed, startRecording, stopRecording, retryTranscription, resetRecording,
  };
}
