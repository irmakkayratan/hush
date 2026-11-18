"use client";
import Link from "next/link";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import HushAccountForm from "../hush-account-form";

type Team = { id: string; name: string };
export default function TeamInvites() {
  const [token, setToken] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState("");
  const [ready, setReady] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    const invite = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!live) return;
      setToken(invite);
      setAccount(user?.email || "");
      if (!user || invite) return;
      const memberships = await supabase.from("memberships").select("workspace_id")
        .eq("user_id", user.id).eq("role", "pm");
      if (!live) return;
      if (memberships.error) throw new Error();
      const ids = (memberships.data || []).map(row => row.workspace_id);
      if (!ids.length) return;
      const result = await supabase.from("workspaces").select("id, name").in("id", ids).order("name");
      if (!live) return;
      if (result.error) throw new Error();
      const choices = result.data || [];
      setTeams(choices);
      const selected = new URLSearchParams(window.location.search).get("team");
      setWorkspaceId(choices.find(team => team.id === selected)?.id || choices[0]?.id || "");
    }
    void load().catch(() => { if (live) setMessage("Could not load your teams. Refresh and try again."); })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [sessionVersion]);
  async function submit() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(""); setLink("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setAccount(""); setMessage("Sign in to continue."); return; }
      const response = await fetch("/api/team-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(token ? { action: "accept", token } : { action: "create", email, workspaceId }),
      });
      const result = await response.json();
      if (!response.ok) { setMessage(result.message || "Could not complete the request."); return; }
      if (token) {
        setJoined(result.workspace.name);
        window.history.replaceState(null, "", window.location.pathname);
      } else {
        setLink(`${window.location.origin}/team-invites#invite=${result.token}`);
      }
    } catch { setMessage("Could not complete the request. Please try again."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <main className="mx-auto min-h-screen max-w-lg space-y-5 bg-white px-6 py-16 text-black">
    <Link href="/" className="text-sm underline">Back to HUSH</Link>
    <h1 className="text-3xl font-semibold">{token ? "Join a team" : "Invite someone"}</h1>
    {!ready ? <p>Loading…</p> : !account ?
      <HushAccountForm onSignedIn={() => setSessionVersion(value => value + 1)} /> :
      <>
        <p className="break-words text-sm text-gray-600">Signed in as {account}</p>
        {joined ? <p role="status">You joined {joined}. Return to HUSH to open your team.</p> : token ?
          <button type="button" disabled={busy} onClick={() => void submit()} className="rounded-full bg-black px-5 py-3 text-white disabled:opacity-50">Accept invitation</button> :
          !teams.length ? <p>You can create invitations for teams you manage.</p> :
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <label className="block">Team<select value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setLink(""); }} disabled={busy} className="mt-2 block w-full rounded-lg border p-3">
              {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select></label>
            <label className="block">Email to invite<input required type="email" maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setLink(""); }} disabled={busy} className="mt-2 block w-full rounded-lg border p-3" /></label>
            <button disabled={busy} className="rounded-full bg-black px-5 py-3 text-white disabled:opacity-50">Create invite link</button>
          </form>}
      </>}
    {link && <label className="block text-sm">Copy this link for the person you invited. It expires in seven days.
      <input readOnly value={link} onFocus={event => event.target.select()} className="mt-2 block w-full rounded-lg border p-3" />
    </label>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </main>;
}
