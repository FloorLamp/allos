"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TelegramBotConfig, TelegramMode } from "@/lib/settings";
import { saveTelegramBotConfig, registerTelegramWebhook } from "../actions";
import SaveStatus from "@/components/SaveStatus";

// The GLOBAL Telegram bot credentials (token + inbound transport mode). One bot
// serves every profile, so this is admin-only. Each profile's enable toggle,
// chat id, and schedule live on Settings → Profile.
export default function ServerTelegramSettings({
  config,
  publicUrl,
}: {
  config: TelegramBotConfig;
  publicUrl: string;
}) {
  const router = useRouter();
  const [botToken, setBotToken] = useState(config.telegramBotToken);
  const [mode, setMode] = useState<TelegramMode>(config.telegramMode);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  function buildFormData() {
    const fd = new FormData();
    fd.set("telegram_bot_token", botToken);
    fd.set("telegram_mode", mode);
    return fd;
  }

  function save() {
    startTransition(async () => {
      await saveTelegramBotConfig(buildFormData());
      setSavedAt(Date.now());
      setResult(null);
      router.refresh();
    });
  }

  // Register acts on *stored* settings, so persist the form first — otherwise
  // unsaved edits are silently ignored. The "Saved" chip stays tied to the Save
  // button: showing it here would read as success even when registration fails.
  function register() {
    const fd = buildFormData();
    startTransition(async () => {
      await saveTelegramBotConfig(fd);
      setResult(await registerTelegramWebhook());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Telegram bot
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        The shared bot that delivers every profile’s reminders. Create one with
        @BotFather for the token. Each profile sets its own chat id and schedule
        on Settings → Profile.
      </p>

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
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
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
        <button type="button" onClick={save} disabled={pending} className="btn">
          Save
        </button>
        {mode === "webhook" && (
          <button
            type="button"
            onClick={register}
            disabled={pending}
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
