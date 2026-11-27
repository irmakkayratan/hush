"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import HushAccountForm from "../hush-account-form";
import ConnectionTest from "./connection-test";

type Team = { id: string; name: string };
type ConnectionStatus = { connected: boolean; notionWorkspace?: string; expired?: boolean; sources?: string[] };
type Property = { id: string; name: string; type: string };
type Source = { id: string; name: string; properties: Property[] };
type Selection = { id: string; titlePropertyId: string; statusPropertyId: string; datePropertyId: string; dateIsDeadline: boolean };
type SourceResult = {
  pending: boolean;
  workspaceId: string;
  teamName: string;
  notionWorkspaceName: string | null;
  hasExistingConnection: boolean;
  sources: Source[];
  nextCursor: string | null;
};

async function token() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Sign in with the HUSH account that started this connection.");
  return data.session.access_token;
}

async function fetchSources(workspaceId: string, next?: string, resume = false, signal?: AbortSignal): Promise<SourceResult> {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspaceId", workspaceId);
  if (next) params.set("cursor", next);
  if (resume) params.set("resume", "1");
  const response = await fetch(`/api/notion/oauth/sources?${params}`, {
    headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store", signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load your Notion task lists. Try again.");
  return data;
}

function defaultSelection(source: Source): Selection {
  return {
    id: source.id,
    titlePropertyId: source.properties.find(property => property.type === "title")?.id || "",
    statusPropertyId: source.properties.find(property => property.type === "status")?.id || "",
    datePropertyId: "",
    dateIsDeadline: false,
  };
}

export default function ConnectNotionPage() {
  const lock = useRef(false);
  const authorizationWindow = useRef<Window | null>(null);
  const [workspaces, setWorkspaces] = useState<Team[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [existing, setExisting] = useState(false);
  const [replace, setReplace] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [message, setMessage] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [notionWorkspace, setNotionWorkspace] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ workspaceId: string; status: ConnectionStatus } | null>(null);
  const [connectionError, setConnectionError] = useState<{ workspaceId: string; message: string } | null>(null);
  const currentStatus = connection?.workspaceId === workspaceId ? connection.status : null;
  const currentError = connectionError?.workspaceId === workspaceId ? connectionError.message : "";
  const teamName = workspaces.find(team => team.id === workspaceId)?.name || "your team";
  const fieldClass = "mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2";
  const buttonClass = "rounded-full bg-black px-6 py-3 text-white disabled:opacity-50";
  const selections = Object.values(selected);
  const validSelection = selections.length > 0 && selections.length <= 20 && selections.every(selection => selection.titlePropertyId && selection.statusPropertyId);

  const showSources = useCallback((data: SourceResult, append: boolean) => {
    setWorkspaceId(data.workspaceId);
    setExisting(data.hasExistingConnection);
    setNotionWorkspace(data.notionWorkspaceName);
    setWorkspaces(teams => teams.some(team => team.id === data.workspaceId)
      ? teams : [...teams, { id: data.workspaceId, name: data.teamName }]);
    setSources(old => append
      ? Array.from(new Map([...old, ...data.sources].map(source => [source.id, source])).values()) : data.sources);
    if (!append) {
      setSelected(previous => {
        const retained = Object.fromEntries(Object.entries(previous).filter(([id]) => data.sources.some(source => source.id === id)));
        if (Object.keys(retained).length || data.sources.length !== 1) return retained;
        const selection = defaultSelection(data.sources[0]);
        return selection.titlePropertyId && selection.statusPropertyId ? { [selection.id]: selection } : {};
      });
    }
    setCursor(data.nextCursor);
    setChoosing(true);
    setSaved(false);
  }, []);

  async function loadSources(next?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      showSources(await fetchSources(workspaceId, next), Boolean(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load your Notion task lists.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    function returned(event: MessageEvent) {
      if (event.origin !== window.location.origin || !authorizationWindow.current ||
          event.source !== authorizationWindow.current || event.data?.type !== "hush-notion-return") return;
      const status = event.data.status;
      if (!["select_sources", "cancelled", "invalid", "denied", "exchange_failed", "failed"].includes(status)) return;
      if (event.data.workspaceId !== workspaceId &&
          !(event.data.workspaceId === null && status !== "select_sources")) return;
      authorizationWindow.current.close();
      authorizationWindow.current = null;
      const destination = new URL("/connect-notion", window.location.origin);
      destination.searchParams.set("workspaceId", workspaceId);
      destination.searchParams.set("oauth", status);
      window.location.assign(destination.toString());
    }
    function refreshed() {
      if (authorizationWindow.current?.closed) {
        authorizationWindow.current = null;
        setSessionVersion(value => value + 1);
      }
    }
    window.addEventListener("message", returned);
    window.addEventListener("focus", refreshed);
    return () => {
      window.removeEventListener("message", returned);
      window.removeEventListener("focus", refreshed);
    };
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      setLoading(true);
      try {
        const returned = new URLSearchParams(window.location.search);
        const status = returned.get("oauth");
        // Return only the result, never tokens, to the app window that opened Notion.
        // If the provider severed the opener, setup continues in this window instead.
        if (status && window.opener) {
          try {
            window.opener.postMessage({
              type: "hush-notion-return", status, workspaceId: returned.get("workspaceId"),
            }, window.location.origin);
          } catch {
            // Continue setup here if the opening app window is no longer reachable.
          }
        }
        const { data: auth, error } = await supabase.auth.getSession();
        if (controller.signal.aborted) return;
        if (error) throw error;
        setSignedIn(Boolean(auth.session));
        if (!auth.session) return;
        const memberships = await supabase.from("memberships").select("workspace_id")
          .eq("user_id", auth.session.user.id).eq("role", "pm").abortSignal(controller.signal);
        if (memberships.error) throw new Error("Could not load your teams. Refresh this page to try again.");
        const ids = (memberships.data || []).map(membership => membership.workspace_id);
        if (!ids.length) {
          setMessage("Only your team's manager can connect Notion. Ask your manager to finish setup, or create your own team.");
          return;
        }
        const teams = await supabase.from("workspaces").select("id, name").in("id", ids).order("name").abortSignal(controller.signal);
        if (teams.error) throw new Error("Could not load your teams. Refresh this page to try again.");
        if (controller.signal.aborted) return;
        const params = new URLSearchParams(window.location.search);
        const requestedTeam = params.get("workspaceId");
        const available = teams.data || [];
        const team = available.find(item => item.id === requestedTeam) || available[0];
        setWorkspaces(available);
        setWorkspaceId(team?.id || "");
        if (status && status !== "select_sources") {
          setMessage(status === "cancelled"
            ? "Notion permission was cancelled. Continue to Notion when you're ready."
            : "Notion setup could not finish. Select Continue to Notion to try again from HUSH.");
          return;
        }
        if (status === "select_sources") setChoosing(true);
        // The temporary grant can still exist after navigating away from the callback URL.
        const pending = await fetchSources(requestedTeam ? team?.id || "" : "", undefined, status !== "select_sources", controller.signal);
        if (controller.signal.aborted) return;
        if (pending.pending) showSources(pending, false);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not resume Notion setup. Try again below.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void initialize();
    return () => controller.abort();
  }, [sessionVersion, showSources]);

  useEffect(() => {
    if (!workspaceId || choosing || loading) return;
    const controller = new AbortController();
    async function checkConnection() {
      try {
        const response = await fetch(`/api/notion/management?workspaceId=${encodeURIComponent(workspaceId)}`, {
          headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store", signal: controller.signal,
        });
        const status = await response.json();
        if (!response.ok) throw new Error(status.message || "Could not check the connection.");
        if (!controller.signal.aborted) {
          setConnection({ workspaceId, status });
          setConnectionError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError({ workspaceId, message: error instanceof Error ? error.message : "Could not check the connection." });
      }
    }
    void checkConnection();
    return () => controller.abort();
  }, [workspaceId, choosing, loading]);

  async function disconnect() {
    if (lock.current || !currentStatus?.connected) return;
    if (!window.confirm(`Disconnect Notion from ${teamName}? HUSH will stop reading and sending updates to this team's task lists until you reconnect.`)) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/notion/management?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${await token()}` },
      });
      const status = await response.json();
      if (!response.ok) throw new Error(status.message || "Could not disconnect Notion.");
      setConnection({ workspaceId, status });
      setConnectionError(null);
      setMessage(`Notion disconnected from ${teamName}.`);
    } catch (error) {
      setConnection(null);
      setConnectionError({ workspaceId, message: error instanceof Error ? error.message : "Could not confirm disconnection. Reload to check." });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function start() {
    if (lock.current) return;
    if (authorizationWindow.current && !authorizationWindow.current.closed) {
      authorizationWindow.current.focus();
      return;
    }
    // Open synchronously from the tap so the installed app keeps its own browser context.
    // Opening after the session/request awaits loses the browser's user activation.
    const installed = window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const popup = installed ? window.open("about:blank", "_blank") : null;
    authorizationWindow.current = popup;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (popup) {
        popup.document.title = "Connect Notion — HUSH";
        popup.document.body?.append("Opening Notion…");
      }
      const response = await fetch("/api/notion/oauth/start", {
        method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not start the connection.");
      const url = new URL(data.authorizationUrl);
      if (url.origin !== "https://api.notion.com" || url.pathname !== "/v1/oauth/authorize") throw new Error("Invalid authorization address.");
      if (popup) {
        if (popup.closed) {
          authorizationWindow.current = null;
          setMessage("Notion setup was closed. Select Continue to Notion when you're ready.");
          return;
        }
        popup.location.replace(url.toString());
        setMessage("Complete the Notion permission screen. HUSH will continue setup when you return.");
      } else {
        window.location.assign(url.toString());
      }
    } catch (error) {
      popup?.close();
      authorizationWindow.current = null;
      setMessage(error instanceof Error ? error.message : "Could not start the connection.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function toggle(source: Source) {
    setSelected(old => {
      const updated = { ...old };
      if (updated[source.id]) delete updated[source.id];
      else updated[source.id] = defaultSelection(source);
      return updated;
    });
  }

  function change(id: string, patch: Partial<Selection>) {
    setSelected(old => ({ ...old, [id]: { ...old[id], ...patch } }));
  }

  async function save() {
    if (lock.current || !validSelection || (existing && !replace)) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/notion/oauth/sources", {
        method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sources: selections, replaceConfirmed: replace }),
      });
      const data = await response.json();
      if (!response.ok || data.saved !== true) throw new Error(data.message || "Could not save the connection. Try again.");
      setSavedCount(data.sourceCount);
      setSaved(true);
      window.history.replaceState(null, "", `/connect-notion?workspaceId=${encodeURIComponent(workspaceId)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not confirm the save. Open Manage connection to check before starting again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const home = workspaceId ? `/?workspaceId=${encodeURIComponent(workspaceId)}` : "/";
  return <main className="min-h-screen bg-white px-6 py-14 text-black"><div className="mx-auto max-w-2xl space-y-6">
    <h1 className="text-3xl font-semibold">{saved ? "Notion is connected" : choosing ? "Finish connecting Notion" : "Connect Notion"}</h1>
    {loading ? <p role="status">Checking your team setup…</p> : !signedIn ? <>
      <p>Sign in with the HUSH account that started this setup. We will continue your Notion connection here.</p>
      <HushAccountForm onSignedIn={() => setSessionVersion(value => value + 1)} />
    </> : <>
      {choosing || saved ? <p>HUSH team <strong>{teamName}</strong>{notionWorkspace && <> · Notion workspace <strong>{notionWorkspace}</strong></>}</p>
        : <p>Choose your HUSH team, allow access in Notion, then return here to select and save its task lists.</p>}
      {!choosing && !saved && <div className="space-y-4">
        <label className="block">HUSH team<select className={fieldClass} value={workspaceId} onChange={event => {
          const id = event.target.value;
          setWorkspaceId(id);
          window.history.replaceState(null, "", `/connect-notion?workspaceId=${encodeURIComponent(id)}`);
        }} disabled={busy}>{workspaces.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        {workspaceId && <div className="space-y-2 rounded-xl border border-neutral-200 p-4" aria-live="polite">
          <p className="font-semibold">{currentError ? "Could not check connection" : !currentStatus ? "Checking connection…" : !currentStatus.connected ? "Setup needed" : currentStatus.expired ? "Reconnect required" : "Connection saved"}</p>
          {currentError && <p className="text-sm text-neutral-600">{currentError}</p>}
          {currentStatus?.connected && <>
            {currentStatus.notionWorkspace && <p>{currentStatus.notionWorkspace}</p>}
            <p className="text-sm text-neutral-600">{currentStatus.sources?.length ? `Task lists: ${currentStatus.sources.join(", ")}` : "Choose a task list to finish setup."}</p>
            <button type="button" disabled={busy} onClick={() => void disconnect()} className="text-sm underline disabled:opacity-50">Disconnect Notion</button>
          </>}
        </div>}
        {currentStatus?.connected && <ConnectionTest key={workspaceId} workspaceId={workspaceId} />}
        <button disabled={busy || !workspaceId} onClick={start} className={buttonClass}>{busy ? "Working…" : currentStatus?.connected ? "Reconnect Notion" : "Continue to Notion"}</button>
        {!workspaces.length && <Link className="block underline" href="/create-team">Create your team</Link>}
      </div>}
      {choosing && !saved && <div className="space-y-6">
        <p className="rounded-xl bg-neutral-50 p-4">Notion access is approved. Select your task list below and press <strong>Save connection</strong> to finish.</p>
        {!sources.length && <p>We could not find a shared task database yet. Select the page containing your task database in Notion. A database needs a task title and a Status property.</p>}
        {sources.map(source => <section key={source.id} className="space-y-4 border-b border-neutral-200 pb-6">
          <label className="flex items-center gap-3"><input type="checkbox" disabled={busy} checked={Boolean(selected[source.id])} onChange={() => toggle(source)} />{source.name}</label>
          {!source.properties.some(property => property.type === "status") && <p className="text-sm text-neutral-600">Add a Status property to this database in Notion, then refresh task lists here.</p>}
          {selected[source.id] && <div className="space-y-3 pl-6">
            {([['titlePropertyId', 'Task title', 'title'], ['statusPropertyId', 'Status', 'status'], ['datePropertyId', 'Date (optional)', 'date']] as const).map(([key, label, type]) => <label className="block" key={key}>{label}<select className={fieldClass} disabled={busy} value={selected[source.id][key]} onChange={event => change(source.id, { [key]: event.target.value, ...(key === "datePropertyId" ? { dateIsDeadline: false } : {}) })}><option value="">{key === "datePropertyId" ? "No date" : "Choose a field"}</option>{source.properties.filter(property => property.type === type).map(property => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>)}
            {selected[source.id].datePropertyId && <label className="flex items-center gap-3"><input type="checkbox" disabled={busy} checked={selected[source.id].dateIsDeadline} onChange={event => change(source.id, { dateIsDeadline: event.target.checked })} />This date is a deadline. Otherwise, show it as a planned date.</label>}
          </div>}
        </section>)}
        {cursor && <button disabled={busy} onClick={() => void loadSources(cursor)} className="underline">Load more task lists</button>}
        {existing && <label className="flex items-start gap-3"><input type="checkbox" disabled={busy} checked={replace} onChange={event => setReplace(event.target.checked)} />Replace this team&apos;s current Notion connection and source list with my selections.</label>}
        <button disabled={busy || !validSelection || (existing && !replace)} onClick={save} className={buttonClass}>{busy ? "Saving…" : "Save connection"}</button>
        {!validSelection && <p className="text-sm text-neutral-600">Select between 1 and 20 task lists and choose each list’s task title and Status fields.</p>}
        <div className="flex flex-wrap gap-4 text-sm">
          <button disabled={busy} onClick={() => void loadSources()} className="underline">Refresh task lists</button>
          <button disabled={busy} onClick={start} className="underline">Choose different Notion pages</button>
        </div>
      </div>}
      {saved && <ConnectionTest key={workspaceId} workspaceId={workspaceId} />}
      {saved && <div className="space-y-4" role="status">
        <p>{savedCount} task {savedCount === 1 ? "list is" : "lists are"} connected to {teamName}. You can now find tasks and send updates.</p>
        <Link className={`${buttonClass} inline-block`} href={home}>Open your team</Link>
      </div>}
    </>}
    {message && <p role="alert" className="leading-7">{message}</p>}
    {workspaceId && <a href={`/connect-notion?workspaceId=${encodeURIComponent(workspaceId)}`} className="block text-sm underline">Manage connection</a>}
    {!saved && <Link href={home} className="block underline">{choosing ? "Return to HUSH before finishing" : "Back to HUSH"}</Link>}
  </div></main>;
}
