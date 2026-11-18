"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type ConnectionStatus = { connected: boolean; notionWorkspace?: string; expired?: boolean; sources?: string[] };
type Property = { id: string; name: string; type: string };
type Source = { id: string; name: string; properties: Property[] };
type Selection = { id: string; titlePropertyId: string; statusPropertyId: string; datePropertyId: string; dateIsDeadline: boolean };
export default function ConnectNotionPage() {
  const lock = useRef(false);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [existing, setExisting] = useState(false);
  const [replace, setReplace] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connection, setConnection] = useState<{ workspaceId: string; status: ConnectionStatus } | null>(null);
  const [connectionError, setConnectionError] = useState<{ workspaceId: string; message: string } | null>(null);
  const currentStatus = connection?.workspaceId === workspaceId ? connection.status : null;
  const currentError = connectionError?.workspaceId === workspaceId ? connectionError.message : "";
  const fieldClass = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2";
  async function token() {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error("Sign in to HUSH first, then return to this page.");
    return data.session.access_token;
  }
  async function loadSources(next?: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/notion/oauth/sources${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load sources.");
      setWorkspaceId(data.workspaceId); setExisting(data.hasExistingConnection);
      setSources(old => next ? Array.from(new Map([...old, ...data.sources].map((source: Source) => [source.id, source])).values()) : data.sources);
      setCursor(data.nextCursor); setChoosing(true);
      if (!data.sources.length && !next) setMessage("No task sources are available yet. Share the task databases when connecting; new access can take a moment to appear.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load sources."); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    const status = new URLSearchParams(window.location.search).get("oauth");
    void (async () => {
      const { data: auth } = await supabase.auth.getSession();
      if (!active) return;
      if (status === "select_sources" && auth.session) { await loadSources(); return; }
      if (status) setMessage(status === "cancelled" ? "Notion connection cancelled. You can start again." : "The connection could not be completed. Start again from this page.");
      if (!auth.session) { if (active) setMessage("Sign in to HUSH first, then return to this page."); return; }
      const memberships = await supabase.from("memberships").select("workspace_id").eq("user_id", auth.session.user.id).eq("role", "pm");
      if (memberships.error) { if (active) setMessage("Could not load your teams."); return; }
      const ids = (memberships.data || []).map(m => m.workspace_id);
      if (!ids.length) { if (active) setMessage("This account does not manage a HUSH team yet."); return; }
      const teams = await supabase.from("workspaces").select("id, name").in("id", ids);
      if (!active) return;
      if (teams.error) { setMessage("Could not load your teams."); return; }
      const availableTeams = teams.data || [];
      const requestedTeam = new URLSearchParams(window.location.search).get("workspaceId");
      setWorkspaces(availableTeams);
      setWorkspaceId(availableTeams.find(team => team.id === requestedTeam)?.id || availableTeams[0]?.id || "");
    })();
    return () => { active = false; };
    // Run only when this page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!workspaceId || choosing) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/notion/management?workspaceId=${encodeURIComponent(workspaceId)}`, {
          headers: { Authorization: `Bearer ${await token()}` },
          signal: controller.signal,
        });
        const status = await response.json();
        if (!response.ok) throw new Error(status.message || "Could not load the connection.");
        if (!controller.signal.aborted) {
          setConnection({ workspaceId, status });
          setConnectionError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError({ workspaceId, message: error instanceof Error ? error.message : "Could not load the connection." });
      }
    })();
    return () => controller.abort();
  }, [workspaceId, choosing]);

  async function disconnect() {
    if (lock.current || !currentStatus?.connected) return;
    const team = workspaces.find(item => item.id === workspaceId)?.name || "this team";
    if (!window.confirm(`Disconnect Notion from ${team}? HUSH will stop reading and sending updates to this team's task lists until you reconnect.`)) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/notion/management?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${await token()}` },
      });
      const status = await response.json();
      if (!response.ok) throw new Error(status.message || "Could not disconnect Notion.");
      setConnection({ workspaceId, status });
      setConnectionError(null);
      setMessage(`Notion disconnected from ${team}.`);
    } catch (error) {
      setConnection(null);
      setConnectionError({ workspaceId, message: error instanceof Error ? error.message : "Could not confirm disconnection. Reload to check." });
    } finally { lock.current = false; setBusy(false); }
  }
  async function start() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/notion/oauth/start", { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not start the connection.");
      const url = new URL(data.authorizationUrl);
      if (url.origin !== "https://api.notion.com" || url.pathname !== "/v1/oauth/authorize") throw new Error("Invalid authorization address.");
      window.location.assign(url.toString());
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start the connection."); lock.current = false; setBusy(false); }
  }
  function toggle(source: Source) {
    setSelected(old => {
      const updated = { ...old };
      if (updated[source.id]) delete updated[source.id];
      else updated[source.id] = { id: source.id, titlePropertyId: source.properties.find(p => p.type === "title")?.id || "", statusPropertyId: source.properties.find(p => p.type === "status")?.id || "", datePropertyId: "", dateIsDeadline: false };
      return updated;
    });
  }
  function change(id: string, patch: Partial<Selection>) { setSelected(old => ({ ...old, [id]: { ...old[id], ...patch } })); }
  async function save() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/notion/oauth/sources", { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ sources: Object.values(selected), replaceConfirmed: replace }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not save the connection.");
      setSaved(true); setMessage(`Notion connected with ${data.sourceCount} task sources.`); window.history.replaceState(null, "", "/connect-notion");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not confirm the result. Check before trying again."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <main className="min-h-screen bg-white px-6 py-14 text-black"><div className="mx-auto max-w-2xl space-y-6">
    <h1 className="text-3xl font-semibold">Connect Notion</h1>
    <p className="leading-7 text-neutral-600">Choose which task lists HUSH can use for your team. In Notion, share only the pages and databases your team needs.</p>
    {!choosing && !saved && <div className="space-y-4">
      <label className="block">HUSH team<select className={fieldClass} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} disabled={busy}>{workspaces.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      {workspaceId && <div className="space-y-2 rounded-xl border border-neutral-200 p-4" aria-live="polite">
        <p className="font-semibold">{currentError ? "Could not check connection" : !currentStatus ? "Checking connection…" : !currentStatus.connected ? "Not connected" : currentStatus.expired ? "Reconnect required" : "Connection saved"}</p>
        {currentError && <p className="text-sm text-neutral-600">{currentError}</p>}
        {currentStatus?.connected && <>
          {currentStatus.notionWorkspace && <p>{currentStatus.notionWorkspace}</p>}
          <p className="text-sm text-neutral-600">{currentStatus.sources?.length ? `Task lists: ${currentStatus.sources.join(", ")}` : "No enabled task lists."}</p>
          <button type="button" disabled={busy} onClick={() => void disconnect()} className="text-sm underline disabled:opacity-50">Disconnect Notion</button>
        </>}
      </div>}
      <button disabled={busy || !workspaceId} onClick={start} className="rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">{busy ? "Working…" : currentStatus?.connected ? "Reconnect Notion" : "Continue to Notion"}</button>
    </div>}
    {choosing && !saved && <div className="space-y-6">
      <p>Choose your task sources and check their fields. Only selected sources will be used after saving.</p>
      {sources.map(source => <section key={source.id} className="space-y-4 border-b border-neutral-200 pb-6">
        <label className="flex items-center gap-3"><input type="checkbox" disabled={busy} checked={Boolean(selected[source.id])} onChange={() => toggle(source)} />{source.name}</label>
        <p className="break-all text-xs text-neutral-500">Source ID: {source.id}</p>
        {selected[source.id] && <div className="space-y-3 pl-6">
          {([['titlePropertyId', 'Task title', 'title'], ['statusPropertyId', 'Status', 'status'], ['datePropertyId', 'Date (optional)', 'date']] as const).map(([key, label, type]) => <label className="block" key={key}>{label}<select className={fieldClass} disabled={busy} value={selected[source.id][key]} onChange={event => change(source.id, { [key]: event.target.value, ...(key === "datePropertyId" ? { dateIsDeadline: false } : {}) })}><option value="">{key === "datePropertyId" ? "No date" : "Choose a field"}</option>{source.properties.filter(p => p.type === type).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>)}
          {selected[source.id].datePropertyId && <label className="flex items-center gap-3"><input type="checkbox" disabled={busy} checked={selected[source.id].dateIsDeadline} onChange={event => change(source.id, { dateIsDeadline: event.target.checked })} />This date is a deadline. Otherwise, show it as a planned date.</label>}
        </div>}
      </section>)}
      {cursor && <button disabled={busy} onClick={() => void loadSources(cursor)} className="underline">Load more sources</button>}
      {!sources.length && <button disabled={busy} onClick={() => void loadSources()} className="underline">Refresh sources</button>}
      {existing && <label className="flex items-start gap-3"><input type="checkbox" disabled={busy} checked={replace} onChange={event => setReplace(event.target.checked)} />Replace this team&apos;s current Notion connection and source list with my selections.</label>}
      <button disabled={busy || !Object.keys(selected).length || (existing && !replace)} onClick={save} className="rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">{busy ? "Working…" : "Save connection"}</button>
    </div>}
    {saved && <a href={`/connect-notion?workspaceId=${encodeURIComponent(workspaceId)}`} className="block underline">Manage connection</a>}
    {message && <p role="status" className="leading-7">{message}</p>}
    <Link href="/" className="block underline">Back to HUSH</Link>
  </div></main>;
}
