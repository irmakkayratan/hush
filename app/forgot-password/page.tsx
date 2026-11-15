"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type ResetRequestResult = "accepted" | "rate-limited" | "failed";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ResetRequestResult | null>(null);
  const pending = useRef(false);

  async function sendLink() {
    if (pending.current) return;
    pending.current = true;
    setSending(true);
    setResult(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: new URL("/reset-password", window.location.origin).href,
      });
      if (error?.status === 429) {
        setResult("rate-limited");
      } else {
        setResult(error ? "failed" : "accepted");
      }
    } catch {
      setResult("failed");
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <section className="w-full max-w-sm">
        <Link href="/" className="text-sm text-gray-300 underline">Back to HUSH</Link>
        <h1 className="mt-6 text-3xl font-bold">Forgot password?</h1>
        <form className="mt-6" onSubmit={event => { event.preventDefault(); void sendLink(); }}>
          <label htmlFor="reset-email" className="block text-sm">HUSH account email</label>
          <input id="reset-email" type="email" autoComplete="email" required disabled={sending}
            value={email} onChange={event => { setEmail(event.target.value); setResult(null); }}
            className="mt-2 block w-full border border-white bg-black px-4 py-3" />
          <button type="submit" disabled={sending}
            className="mt-4 rounded-full bg-white px-6 py-3 text-black disabled:opacity-50">
            {sending ? "Sending…" : result === "accepted" ? "Resend reset link" : "Send reset link"}
          </button>
          {result === "accepted" && (
            <p role="status" className="mt-4 text-sm text-gray-300">
              If the address is registered, look for a reset link in your inbox or spam folder. You can correct the address above or request another link.
            </p>
          )}
          {result === "rate-limited" && (
            <p role="alert" className="mt-4 text-sm text-gray-300">Too many reset requests. Wait a few minutes before trying again.</p>
          )}
          {result === "failed" && (
            <p role="alert" className="mt-4 text-sm text-gray-300">We couldn’t process the reset request. Try again later or contact your HUSH administrator.</p>
          )}
        </form>
      </section>
    </main>
  );
}
