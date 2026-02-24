"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const errorMsg = (() => {
          if (!data || typeof data !== "object") return null;
          if (!("error" in data)) return null;
          const err = (data as { error?: unknown }).error;
          return typeof err === "string" ? err : null;
        })();
        setError(errorMsg ?? "Registration failed");
        return;
      }
      router.replace("/");
    } catch {
      setError("Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
          <p className="mt-1 text-sm text-foreground/70">
            Choose a username and password.
          </p>
        </header>

        {error ? (
          <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="rounded-3xl border border-foreground/15 bg-background p-5"
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className="h-11 rounded-xl border border-foreground/15 bg-background px-4 text-sm"
              />
              <span className="text-[11px] text-foreground/60">
                3–32 chars. Letters, numbers, spaces, _ and -
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="h-11 rounded-xl border border-foreground/15 bg-background px-4 text-sm"
              />
              <span className="text-[11px] text-foreground/60">Minimum 8 characters</span>
            </label>

            <button
              type="submit"
              disabled={busy}
              className="h-11 rounded-full bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create account"}
            </button>

            <p className="text-sm text-foreground/70">
              Already have an account?{" "}
              <Link href="/login" className="font-medium hover:underline">
                Sign in
              </Link>
              .
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
