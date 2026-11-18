"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import HushAccountForm from "../hush-account-form";

export default function CreateTeamPage() {
  const lock = useRef(false);
  const attempt = useRef<{ id: string; name: string } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => { if (active) setSignedIn(Boolean(data.session)); });
    return () => { active = false; };
  }, []);
  async function create() {
    if (lock.current || created) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const cleanName = name.replace(/\s+/g, " ").trim();
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) { setSignedIn(false); throw new Error("Sign in before creating your team."); }
      if (!attempt.current || attempt.current.name !== cleanName) attempt.current = { id: crypto.randomUUID(), name: cleanName };
      const response = await fetch("/api/teams", { method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: cleanName, workspaceId: attempt.current.id }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.created) throw new Error(result?.message || "Could not create the team.");
      setCreated(result.workspace);
      localStorage.setItem("hush_active_workspace", result.workspace.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not confirm creation. Retry here with the same name."); }
    finally { lock.current = false; setBusy(false); }
  }
  const field = "mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-3";
  return <main className="min-h-screen bg-white px-6 py-16 text-black"><div className="mx-auto max-w-lg space-y-6">
    <h1 className="text-3xl font-semibold">Create your team</h1>
    <p className="leading-7 text-neutral-600">Give your team a name, then connect the Notion task lists you want to use together. Each team has its own connection and members.</p>
    {!signedIn ? <HushAccountForm onSignedIn={() => setSignedIn(true)} /> : created ? <div className="space-y-4"><p role="status">{created.name} is ready. You are this team&apos;s manager.</p><a className="inline-block rounded-full bg-black px-6 py-3 text-white" href={`/connect-notion?workspaceId=${encodeURIComponent(created.id)}`}>Connect Notion</a></div> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="block">Team name<input className={field} required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="Your team or studio" /></label>
      <p className="text-sm leading-6 text-neutral-600">Creating a team does not give it access to your other teams or their Notion pages.</p>
      <button disabled={busy} className="rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">{busy ? "Creating…" : "Create team"}</button>
    </form>}
    {message && <p role="status">{message}</p>}
    <Link href="/" className="block underline">Back to HUSH</Link>
  </div></main>;
}
