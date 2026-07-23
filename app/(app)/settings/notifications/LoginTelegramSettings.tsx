"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LoginTelegram } from "@/lib/settings";
import { saveLoginTelegram, sendTestNotification } from "../actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The LOGIN-scoped Telegram delivery channel (issue #1072): the chat belongs to the
// person signed in, and a notification for ANY profile they manage fans out to this
// chat. The global bot token + transport mode are admin-managed on Settings →
// Server. Per-profile muting ("don't notify me about Grandpa") lives in the profile
// section below.
export default function LoginTelegramSettings({
  telegram,
  botConfigured,
  reviewNeeded,
}: {
  telegram: LoginTelegram;
  botConfigured: boolean;
  // Post-migration "review your notification settings" flag (#1072) — set when the
  // channel migration couldn't derive an unambiguous chat for this login.
  reviewNeeded: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(telegram.telegramEnabled);
  const [chatId, setChatId] = useState(telegram.telegramChatId);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || testing;

  function buildFormData() {
    const fd = new FormData();
    fd.set("telegram_enabled", enabled ? "1" : "0");
    fd.set("telegram_chat_id", chatId);
    return fd;
  }

  function save() {
    runSave(async () => {
      await saveLoginTelegram(buildFormData());
      setResult(null);
      router.refresh();
    });
  }

  // Test acts on STORED settings, so persist the form first — otherwise unsaved
  // edits are silently ignored. The try/catch keeps a transient throw from
  // escalating to the error boundary.
  function test() {
    const fd = buildFormData();
    startTest(async () => {
      try {
        await saveLoginTelegram(fd);
        setResult(await sendTestNotification());
        router.refresh();
      } catch {
        setResult({ ok: false, message: "Couldn’t send the test. Try again." });
      }
    });
  }

  return (
    <div id="login-telegram" className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Telegram (your chat)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Reminders for every profile you manage arrive in this Telegram chat,
        with one-tap “taken” buttons. Find your chat id at{" "}
        <code>api.telegram.org/bot&lt;token&gt;/getUpdates</code>.
      </p>

      {reviewNeeded && (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="notify-review-needed"
        >
          Review your Telegram chat — it was moved from a per-profile setting
          and couldn’t be picked automatically. Confirm the chat id below and
          save.
        </p>
      )}

      {!botConfigured && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          No Telegram bot is configured yet. An admin sets the bot token on
          Settings → Server; until then reminders can’t be sent.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
          data-testid="login-telegram-enabled"
        />
        Enable Telegram notifications
      </label>

      {enabled && (
        <div>
          <label className="label">Chat ID</label>
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="e.g. 987654321"
            className="input"
            data-testid="login-telegram-chat-id"
          />
        </div>
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
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
