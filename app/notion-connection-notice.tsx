"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function NotionConnectionNotice({ workspaceId, teamName }: {
  workspaceId: string;
  teamName: string;
}) {
  const [status, setStatus] = useState<{ ready: boolean; canManage: boolean } | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error("Sign in again to check your team's Notion connection.");
        const response = await fetch(`/api/notion/connection?workspaceId=${encodeURIComponent(workspaceId)}`, {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Could not check the Notion connection.");
        if (!controller.signal.aborted) {
          setStatus(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not check the Notion connection.");
      }
    }
    void check();
    const refresh = () => setVersion(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceId, version]);

  if (!error && (!status || status.ready)) return null;
  return <div className="mt-6 rounded-2xl border border-[#D9DDD8] p-5 text-left" role="status">
    {error ? <>
      <p className="text-sm">{error}</p>
      <button className="mt-3 text-sm underline" onClick={() => setVersion(value => value + 1)}>Check again</button>
    </> : <>
      <h2 className="font-semibold">Finish connecting Notion for {teamName}</h2>
      <p className="mt-2 text-sm text-gray-600">{status?.canManage
        ? "Choose your Notion task list and save the connection so HUSH can find tasks for your notes."
        : "Ask your team manager to finish selecting and saving this team's Notion task list."}</p>
      {status?.canManage && <Link className="mt-3 inline-block rounded-full bg-black px-5 py-3 text-sm text-white"
        href={`/connect-notion?workspaceId=${encodeURIComponent(workspaceId)}`}>Continue Notion setup</Link>}
    </>}
  </div>;
}
