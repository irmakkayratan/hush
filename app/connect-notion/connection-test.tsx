"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Source = { id: string; name: string };

async function requestTest(workspaceId: string, sourceId?: string, method = "GET", signal?: AbortSignal) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Sign in to HUSH again.");
  const query = new URLSearchParams({ workspaceId });
  if (sourceId) query.set("sourceId", sourceId);
  const response = await fetch(`/api/notion/connection-test?${query}`, {
    method,
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Could not test this connection.");
  return result;
}

export default function ConnectionTest({ workspaceId }: { workspaceId: string }) {
  const inFlight = useRef(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [taskUrl, setTaskUrl] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void requestTest(workspaceId, undefined, "GET", controller.signal).then(({ sources }) => {
      if (controller.signal.aborted) return;
      setSources(sources);
      setSourceId(sources.length === 1 ? sources[0].id : "");
    }).catch(error => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not load the task lists.");
    });
    return () => controller.abort();
  }, [workspaceId]);

  async function run(createTask: boolean) {
    if (!sourceId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setTaskUrl("");
    setMessage("");
    if (!createTask) setChecked(false);
    try {
      const result = await requestTest(workspaceId, sourceId, createTask ? "POST" : "GET");
      if (createTask) {
        setTaskUrl(result.taskUrl);
        setMessage("Test task created. You can remove it after checking it.");
      } else {
        setChecked(true);
        setMessage(`HUSH can read ${result.source.name}.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not test the connection.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const button = "rounded-full border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50";
  return <section aria-labelledby="connection-test-heading" className="space-y-3 rounded-xl border border-neutral-200 p-4">
    <h2 id="connection-test-heading" className="font-semibold">Test the Notion connection</h2>
    {sources.length > 0 && <>
      <label className="block text-sm">
        Task list
        <select value={sourceId} disabled={busy} className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2" onChange={event => {
          setSourceId(event.target.value);
          setChecked(false);
          setMessage("");
          setTaskUrl("");
        }}>
          {sources.length > 1 && <option value="">Choose a task list</option>}
          {sources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy || !sourceId} onClick={() => void run(false)}>Check connection</button>
        <button type="button" className={button} disabled={busy || !checked || Boolean(taskUrl)} onClick={() => void run(true)}>Create test task</button>
      </div>
    </>}
    {busy && <p role="status" className="text-sm">Checking with Notion…</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {taskUrl && <a className="inline-block text-sm underline" href={taskUrl} target="_blank" rel="noopener noreferrer">Open test task in Notion</a>}
  </section>;
}
