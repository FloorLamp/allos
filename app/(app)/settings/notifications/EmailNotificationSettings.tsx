"use client";

import { useState, useTransition } from "react";
import type { LoginEmailNotify } from "@/lib/settings";
import { saveLoginEmailNotify, sendTestEmailNotification } from "../actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The LOGIN-scoped email delivery channel (issue #1855): reminders for every
// profile this login manages can arrive at the login's own email address — the
// same address auth mail uses (logins.email, admin-managed on Settings → Family).
// The card owns the enable toggle and the CONTENT MODE, the #1855 PHI decision:
// content-free is the default, and only the radio below — the user's own tap —
// ever widens a login to full-content mail.
export default function EmailNotificationSettings({
  email,
  address,
  smtpConfigured,
}: {
  email: LoginEmailNotify;
  // The login's address (logins.email), or "" when none is on file.
  address: string;
  smtpConfigured: boolean;
}) {
  const [enabled, setEnabled] = useState(email.emailEnabled);
  const [fullContent, setFullContent] = useState(email.emailFullContent);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || testing;

  function buildFormData() {
    const fd = new FormData();
    fd.set("email_enabled", enabled ? "1" : "0");
    fd.set("email_full_content", fullContent ? "1" : "0");
    return fd;
  }

  function save() {
    runSave(async () => {
      await saveLoginEmailNotify(buildFormData());
      setResult(null);
    });
  }

  // Test acts on STORED settings (including the content mode, so the test mail
  // arrives in the shape real reminders will take) — persist the form first.
  function test() {
    const fd = buildFormData();
    startTest(async () => {
      try {
        await saveLoginEmailNotify(fd);
        setResult(await sendTestEmailNotification());
      } catch {
        setResult({ ok: false, message: "Couldn’t send the test. Try again." });
      }
    });
  }

  return (
    <div id="login-email" className="card space-y-5" data-testid="login-email">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Email (your inbox)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Reminders for every profile you manage can arrive at your
        account&rsquo;s email address
        {address ? (
          <>
            {" "}
            (<code data-testid="login-email-address">{address}</code>)
          </>
        ) : null}
        . Email can&rsquo;t carry one-tap buttons — for those, use Telegram.
      </p>

      {!smtpConfigured && (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="login-email-no-smtp"
        >
          No outgoing mail server is configured yet. An admin sets SMTP on
          Settings → Server; until then email can&rsquo;t be sent.
        </p>
      )}

      {!address && (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="login-email-no-address"
        >
          Your login has no email address. An admin can add one on Settings →
          Family.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
          data-testid="login-email-enabled"
        />
        Enable email notifications
      </label>

      {enabled && (
        <fieldset className="space-y-2">
          <legend className="label">What emails may contain</legend>
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="radio"
              name="email_content_mode"
              checked={!fullContent}
              onChange={() => setFullContent(false)}
              className="mt-0.5 h-4 w-4 accent-brand-600"
              data-testid="email-content-free"
            />
            <span>
              Just a nudge (recommended)
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Emails only say something needs your attention — never what it
                is. Open Allos to see the details.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="radio"
              name="email_content_mode"
              checked={fullContent}
              onChange={() => setFullContent(true)}
              className="mt-0.5 h-4 w-4 accent-brand-600"
              data-testid="email-full-content"
            />
            <span>
              Full content
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Emails carry the reminder text itself — medication names and
                other health details will appear in your inbox and wherever your
                mail is stored or forwarded.
              </span>
            </span>
          </label>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="btn">
          Save
        </button>
        {enabled && (
          <button
            type="button"
            onClick={test}
            disabled={busy}
            className="btn-ghost"
            data-testid="login-email-send-test"
          >
            Send test email
          </button>
        )}
      </div>

      {result && (
        <p
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
          data-testid="login-email-test-result"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
