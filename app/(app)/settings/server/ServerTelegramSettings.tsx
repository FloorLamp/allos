"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TelegramBotConfig, TelegramMode } from "@/lib/settings";
import type { NotifyErrorMarker } from "@/lib/notifications/delivery-status";
import { saveTelegramBotConfig, registerTelegramWebhook } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { NOTICE_TONE } from "@/components/Notice";
import { useSaveStatus } from "@/components/useSaveStatus";

// The GLOBAL Telegram bot credentials (token + inbound transport mode). One bot
// serves every profile, so this is admin-only. Each profile's enable toggle,
// chat id, and schedule live on Settings → Profile.
export default function ServerTelegramSettings({
  config,
  publicUrl,
  lastError,
}: {
  config: TelegramBotConfig;
  publicUrl: string;
  // The last notification-delivery failure (#131), or null when the most recent
  // send succeeded. The per-profile "Send test" button on Settings → Profile is
  // the remediation path — a successful test clears this marker.
  lastError: NotifyErrorMarker | null;
}) {
  const router = useRouter();
  const [botToken, setBotToken] = useState(config.telegramBotToken);
  const [mode, setMode] = useState<TelegramMode>(config.telegramMode);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  // Register drives the result message, not the "saved" chip, so it keeps its own
  // transition (see the note on register()).
  const [registering, startRegister] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || registering;

  function buildFormData() {
    const fd = new FormData();
    fd.set("telegram_bot_token", botToken);
    fd.set("telegram_mode", mode);
    return fd;
  }

  function save() {
    runSave(async () => {
      await saveTelegramBotConfig(buildFormData());
      setResult(null);
      router.refresh();
    });
  }

  // Register acts on *stored* settings, so persist the form first — otherwise
  // unsaved edits are silently ignored. The "Saved" chip stays tied to the Save
  // button: showing it here would read as success even when registration fails.
  // The try/catch keeps a transient throw from escalating to the error boundary.
  function register() {
    const fd = buildFormData();
    startRegister(async () => {
      try {
        await saveTelegramBotConfig(fd);
        setResult(await registerTelegramWebhook());
      } catch {
        setResult({
          ok: false,
          message: "Couldn’t register the webhook. Please try again.",
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Telegram bot
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The shared bot that delivers every profile’s reminders. Create one with
        @BotFather for the token. Each profile sets its own chat id and schedule
        on Settings → Profile.
      </p>

      {lastError && (
        <div
          data-testid="notify-last-error"
          className={`rounded-lg border p-3 text-xs ${NOTICE_TONE.rose}`}
        >
          <div className="font-medium">
            Last notification delivery failed
            {lastError.channel ? ` (${lastError.channel})` : ""}
          </div>
          <div className="mt-0.5 break-words">{lastError.error}</div>
          {lastError.at && (
            <div className="mt-0.5 opacity-80">
              {new Date(lastError.at).toLocaleString()}
            </div>
          )}
          <div className="mt-1 opacity-80">
            Fix the bot token above (or the chat id on Settings → Profile), then
            use “Send test” on Settings → Profile — a successful send clears
            this.
          </div>
        </div>
      )}

      <div>
        <label className="label">Bot token</label>
        <input
          type="text"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456:ABC-DEF…"
          className="input"
        />
      </div>

      <div>
        <label className="label">Button taps</label>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="radio"
              name="telegram_mode"
              checked={mode === "poll"}
              onChange={() => setMode("poll")}
              className="h-4 w-4 accent-brand-600"
            />
            Polling — no public URL needed; the notify service picks up taps
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="radio"
              name="telegram_mode"
              checked={mode === "webhook"}
              onChange={() => setMode("webhook")}
              className="h-4 w-4 accent-brand-600"
            />
            Webhook — Telegram calls the app directly (needs the public app URL)
          </label>
        </div>
        {mode === "webhook" && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Telegram POSTs button taps to{" "}
            <code className="break-all">
              {publicUrl || "<public URL>"}
              /api/telegram/webhook
            </code>
            {publicUrl
              ? ". Save, then register the webhook below."
              : " — set the public app URL in the card above first."}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="btn">
          Save
        </button>
        {mode === "webhook" && (
          <button
            type="button"
            onClick={register}
            disabled={busy}
            className="btn-ghost"
          >
            Register webhook
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
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
