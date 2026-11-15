"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createHushClient } from "@/lib/supabase-client";

function createRecoveryClient() {
  return createHushClient({ auth: {
    storageKey: "hush-password-recovery",
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  } });
}

export default function ResetPassword() {
  const [status, setStatus] = useState<"checking" | "invalid" | "ready" | "done">("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const recovery = useRef<ReturnType<typeof createRecoveryClient> | null>(null);
  const validation = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!validation.current) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      window.history.replaceState(window.history.state, "", window.location.pathname);

      validation.current = (async () => {
        if (params.get("type") !== "recovery" || !access_token || !refresh_token) return false;
        const client = createRecoveryClient();
        const { data, error } = await client.auth.setSession({ access_token, refresh_token });
        if (error || !data.session) return false;
        recovery.current = client;
        return true;
      })().catch(() => false);
    }

    let active = true;
    void validation.current.then(valid => { if (active) setStatus(valid ? "ready" : "invalid"); });
    return () => { active = false; };
  }, []);

  async function updatePassword() {
    const client = recovery.current;
    if (!client || pending.current) return;
    if (password !== confirmation) {
      setMessage("The passwords don’t match.");
      return;
    }

    pending.current = true;
    setSaving(true);
    setMessage("");
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error?.status === 401 || error?.code === "session_not_found") {
        recovery.current = null;
        setStatus("invalid");
        return;
      }
      if (error?.code === "weak_password" || error?.code === "same_password") {
        setMessage(error.message);
        return;
      }
      if (error) throw error;
      recovery.current = null;
      setPassword("");
      setConfirmation("");
      setStatus("done");
      await client.auth.signOut({ scope: "local" });
    } catch {
      setMessage("We couldn't update your password right now. Please try again.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <section className="w-full max-w-sm">
        <Link href="/" className="text-sm text-gray-300 underline">Back to HUSH</Link>
        <h1 className="mt-6 text-3xl font-bold">Reset your password</h1>
        {status === "checking" && <p className="mt-4 text-sm text-gray-300" role="status">Checking your reset link…</p>}
        {status === "invalid" && (
          <p className="mt-4 text-sm text-gray-300" role="status">
            This reset link is invalid or has expired. <Link href="/forgot-password" className="underline">Request a new link</Link>.
          </p>
        )}
        {status === "done" && <p className="mt-4 text-sm text-gray-300" role="status">Password updated. Return to HUSH and use your new password to sign in.</p>}
        {status === "ready" && (
          <form className="mt-6" onSubmit={event => { event.preventDefault(); void updatePassword(); }}>
            <label htmlFor="new-password" className="block text-sm">New password</label>
            <input id="new-password" type="password" autoComplete="new-password" required minLength={6} disabled={saving}
              value={password} onChange={event => setPassword(event.target.value)}
              className="mt-2 block w-full border border-white bg-black px-4 py-3" />
            <label htmlFor="confirm-password" className="mt-4 block text-sm">Confirm new password</label>
            <input id="confirm-password" type="password" autoComplete="new-password" required minLength={6} disabled={saving}
              value={confirmation} onChange={event => setConfirmation(event.target.value)}
              className="mt-2 block w-full border border-white bg-black px-4 py-3" />
            <button type="submit" disabled={saving}
              className="mt-4 rounded-full bg-white px-6 py-3 text-black disabled:opacity-50">
              {saving ? "Updating…" : "Update password"}
            </button>
            {message && <p role="alert" className="mt-4 text-sm text-gray-300">{message}</p>}
          </form>
        )}
      </section>
    </main>
  );
}
