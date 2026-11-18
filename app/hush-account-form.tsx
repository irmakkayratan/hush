"use client";

import { useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";

export default function HushAccountForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const field = "mt-2 block w-full rounded-lg border border-neutral-300 bg-white px-4 py-3";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const credentials = { email: email.trim(), password };
      const { data, error } = register
        ? await supabase.auth.signUp(credentials)
        : await supabase.auth.signInWithPassword(credentials);
      if (error) throw error;
      setPassword("");
      if (data.session) {
        onSignedIn();
      } else if (register) {
        setRegister(false);
        setMessage("Check your email to confirm your account, then return here to sign in.");
      } else {
        setMessage("Could not sign in. Try again.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not complete the request. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block">Email
        <input className={field} type="email" required autoComplete="email" value={email}
          onChange={event => setEmail(event.target.value)} disabled={busy} />
      </label>
      <label className="block">Password
        <input className={field} type="password" required autoComplete={register ? "new-password" : "current-password"}
          minLength={register ? 6 : undefined} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
      </label>
      <button disabled={busy} className="rounded-full bg-black px-6 py-3 text-white disabled:opacity-50">
        {busy ? "Working…" : register ? "Create account" : "Sign in"}
      </button>
      <button type="button" disabled={busy} className="ml-3 text-sm underline" onClick={() => {
        setRegister(value => !value);
        setMessage("");
      }}>{register ? "I have an account" : "Create an account"}</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  );
}
