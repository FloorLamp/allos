"use client";

import { useState, useTransition } from "react";
import { changeOwnPassword } from "./actions";

// Self-service password change for the signed-in login. Verifies the current
// password server-side, then signs out the login's other sessions.
export default function ChangePasswordSettings({
  username,
}: {
  username: string;
}) {
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [result, setResult] = useState<
    { ok: true; message: string } | { ok: false; error: string } | null
  >(null);

  function save() {
    const fd = new FormData();
    fd.set("current_password", current);
    fd.set("new_password", next);
    start(async () => {
      const r = await changeOwnPassword(fd);
      setResult(r);
      if (r.ok) {
        setCurrent("");
        setNext("");
      }
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Password
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Change the password for your login ({username}). Your other signed-in
          devices are logged out.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password"
          type="password"
          autoComplete="current-password"
          className="input"
        />
        <input
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="New password"
          type="password"
          autoComplete="new-password"
          className="input"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || !current || !next}
          className="btn"
        >
          Change password
        </button>
        {result && (
          <p
            className={`text-sm ${
              result.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            }`}
          >
            {result.ok ? result.message : result.error}
          </p>
        )}
      </div>
    </div>
  );
}
