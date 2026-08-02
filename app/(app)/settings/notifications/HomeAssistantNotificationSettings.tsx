"use client";

import { useState, useTransition } from "react";
import type { ProfileHomeAssistant } from "@/lib/settings";
import {
  saveHomeAssistantPrefs,
  sendTestHomeAssistant,
} from "../profile/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Home Assistant as a third delivery channel (#248). A per-profile outbound webhook
// so HA can announce reminders on a kitchen speaker (TTS), flash lights on
// escalation, or hold a message until someone's home — presence/room-aware delivery
// the app itself can't do.
//
// THIS CARD IS THE CHANNEL, NOT THE ROUTING (#1868 §1). It used to carry a per-kind
// checkbox grid ("Announce which reminders") over `ha_notify_disabled_kinds` — the
// SAME key the Message-kinds matrix's HA column writes, i.e. 26 checkboxes for 13
// booleans on one page, while the page's own header comment claimed the matrix had
// already replaced per-kind duplication. The grid is gone; the matrix column is the
// one editor, and `saveHomeAssistantPrefs` now PRESERVES the stored set rather than
// deriving it from this form.
export default function HomeAssistantNotificationSettings({
  config,
}: {
  config: ProfileHomeAssistant;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [webhookUrl, setWebhookUrl] = useState(config.webhookUrl);
  const [secret, setSecret] = useState(config.secret);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  // The test send drives the result message, not the "saved" chip, so it keeps its
  // own transition.
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || testing;

  function buildFormData() {
    const fd = new FormData();
    fd.set("ha_enabled", enabled ? "1" : "0");
    fd.set("ha_webhook_url", webhookUrl);
    fd.set("ha_secret", secret);
    return fd;
  }

  function save() {
    runSave(async () => {
      const res = await saveHomeAssistantPrefs(buildFormData());
      if (!res.ok) {
        setResult({ ok: false, message: res.error });
        // Throw so the hook records a failure (no "saved" chip) rather than
        // treating a rejected config as a successful save.
        throw new Error(res.error);
      }
      setResult(null);
    });
  }

  // Test acts on STORED settings, so persist first (matching the Telegram block) —
  // otherwise an unsaved URL edit is ignored. Only send the test once the save
  // succeeded, so an invalid URL surfaces its own error instead of a send failure.
  // The try/catch keeps a transient throw from escalating to the error boundary.
  function test() {
    startTest(async () => {
      try {
        const res = await saveHomeAssistantPrefs(buildFormData());
        if (!res.ok) {
          setResult({ ok: false, message: res.error });
          return;
        }
        setResult(await sendTestHomeAssistant());
      } catch {
        setResult({
          ok: false,
          message: "Couldn’t send the test. Try again.",
        });
      }
    });
  }

  return (
    <div className="card space-y-5" data-testid="ha-settings">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Notifications (Home Assistant)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Send reminders to a{" "}
        <a
          href="https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Home Assistant webhook
        </a>{" "}
        so HA can announce doses on a kitchen speaker, flash lights on a missed
        dose, or hold a message until someone’s home. See{" "}
        <code>docs/home-assistant-notifications.md</code> for the automation
        recipes.
      </p>

      <p className="text-xs text-amber-600 dark:text-amber-400">
        The webhook payload contains medication names (PHI) and usually travels
        over your LAN. Use an <code>https</code> Home Assistant URL when the
        instances aren’t on the same network, and set a shared secret below.
      </p>

      <label
        className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"
        data-testid="ha-status"
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
          data-testid="ha-enable"
        />
        Enable Home Assistant notifications
      </label>

      {enabled && (
        <>
          <div>
            <label className="label">Webhook URL</label>
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="http://homeassistant.local:8123/api/webhook/allos-mom"
              className="input"
              data-testid="ha-webhook-url"
            />
          </div>

          <div>
            <label className="label">Shared secret (optional)</label>
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="a random string HA checks on the request header"
              className="input"
              data-testid="ha-secret"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Sent as the <code>X-Allos-Webhook-Secret</code> header so an HA
              automation can reject calls that don’t carry it.
            </p>
          </div>

          <p
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="ha-kinds-pointer"
          >
            Which reminders Home Assistant announces is the <strong>HA</strong>{" "}
            column of the Message kinds table below — it is the one place that
            setting lives.
          </p>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* NOT labeled "Save": the Telegram card above already has a "Save"
            button, and Playwright's getByRole name matching is case-insensitive
            SUBSTRING matching — so any accessible name containing "Save" (even
            "Save Home Assistant") would make pre-existing bare
            getByRole("button", { name: "Save" }) clicks on this page ambiguous
            (strict-mode failure). Distinct verb keeps every spec unambiguous. */}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="btn"
          data-testid="ha-save"
        >
          Apply Home Assistant settings
        </button>
        {enabled && (
          <button
            type="button"
            onClick={test}
            disabled={busy}
            className="btn-ghost"
            data-testid="ha-test"
          >
            Send test notification
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
          data-testid="ha-result"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
