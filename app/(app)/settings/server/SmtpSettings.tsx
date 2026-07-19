"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SmtpConfigView } from "@/lib/settings";
import { saveSmtpConfig, sendTestEmail } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The GLOBAL SMTP relay (issue #985). Admin-only: one relay serves the whole
// instance and backs the invite + self-service password-reset emails. The password
// is write-only — a blank submit keeps the stored secret; the "remove" checkbox
// clears it. Login-lifecycle links also need the public app URL (the card above);
// this card notes when it's missing.
export default function SmtpSettings({
  config,
  publicUrl,
}: {
  config: SmtpConfigView;
  publicUrl: string;
}) {
  const router = useRouter();
  const [host, setHost] = useState(config.host);
  const [port, setPort] = useState(String(config.port));
  const [user, setUser] = useState(config.user);
  const [from, setFrom] = useState(config.from);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testTo, setTestTo] = useState("");
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || testing;

  function buildFormData() {
    const fd = new FormData();
    fd.set("smtp_host", host);
    fd.set("smtp_port", port);
    fd.set("smtp_user", user);
    fd.set("smtp_from", from);
    fd.set("smtp_password", password);
    if (clearPassword) fd.set("clear_smtp_password", "1");
    return fd;
  }

  function save() {
    runSave(async () => {
      await saveSmtpConfig(buildFormData());
      setResult(null);
      setPassword("");
      setClearPassword(false);
      router.refresh();
    });
  }

  // Test acts on STORED settings, so persist the form first (sendTestEmail saves,
  // then sends). Runs its own transition + result line, separate from the "saved"
  // chip (the register-webhook precedent).
  function test() {
    const fd = buildFormData();
    fd.set("test_to", testTo);
    startTest(async () => {
      try {
        setResult(await sendTestEmail(fd));
      } catch {
        setResult({
          ok: false,
          message: "Couldn't send the test email. Try again.",
        });
      }
      setPassword("");
      setClearPassword(false);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Outbound email (SMTP)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Your own SMTP server (Fastmail, a Gmail app-password, SES-SMTP, …) — it
        owns deliverability. Used to email login invites and password-reset
        links. Until it&apos;s set, those affordances stay hidden. TLS is
        required (port 465 implicit, 587 via STARTTLS).
      </p>

      {!publicUrl && (
        <p
          data-testid="smtp-needs-public-url"
          className="rounded-lg border border-amber-400/40 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Set the public app URL in the card above — invite and reset links are
          built from it, so email can&apos;t be sent without it.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">SMTP host</label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            data-testid="smtp-host"
            className="input"
          />
        </div>
        <div>
          <label className="label">Port</label>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="587"
            data-testid="smtp-port"
            className="input"
          />
        </div>
        <div>
          <label className="label">From address</label>
          <input
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="allos@example.com"
            data-testid="smtp-from"
            className="input"
          />
        </div>
        <div>
          <label className="label">Username (optional)</label>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="off"
            data-testid="smtp-user"
            className="input"
          />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={config.hasPassword ? "•••••• (stored)" : ""}
            autoComplete="new-password"
            disabled={clearPassword}
            data-testid="smtp-password"
            className="input disabled:opacity-40"
          />
          {config.hasPassword && (
            <label className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) => setClearPassword(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-600"
              />
              Remove stored password
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Distinct verb, not "Save" (#928): keep exactly one "Save"-named button
            per page for Playwright's substring role matching. */}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="btn"
          data-testid="smtp-apply"
        >
          Apply email settings
        </button>
      </div>

      <div className="border-t border-black/10 pt-4 dark:border-white/10">
        <label className="label">Send a test email to</label>
        <div className="flex items-end gap-2">
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
            data-testid="smtp-test-to"
            className="input"
          />
          <button
            type="button"
            onClick={test}
            disabled={busy || !testTo.trim()}
            className="btn-ghost shrink-0"
            data-testid="smtp-test"
          >
            Send test
          </button>
        </div>
      </div>

      {result && (
        <p
          data-testid="smtp-result"
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
