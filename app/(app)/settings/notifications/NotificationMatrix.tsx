"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NotificationKind } from "@/lib/notifications/types";
import {
  TOGGLEABLE_NOTIFICATION_KINDS,
  isSafetyKind,
  serializeDisabledKinds,
} from "@/lib/notifications/home-assistant-core";
import { isPushDeliverableKind } from "@/lib/notifications/push-core";
import { saveHomeAssistantNotifyKinds } from "../profile/actions";
import { savePushNotifyKinds, saveLoginTelegramNotifyKinds } from "../actions";

// The kind × channel matrix (#928) — the Notifications tab's centerpiece. Rows are
// notification kinds, columns are the three channels, so "which messages reach me
// where" reads in one glance. Each column persists in ITS channel's tier store
// through a tier-correct action (#319): Telegram + Web Push follow the LOGIN (#1072),
// Home Assistant follows the PROFILE — labeled accordingly. A checked cell means "this kind
// reaches this channel"; unchecking adds the kind to that channel's DISABLED set.
//
// Rules baked in:
//  - `test` and the internal `other` kind never appear (they aren't user-toggleable).
//  - Web Push can't deliver the button-only `food` kind (PUSH_UNDELIVERABLE_KINDS) —
//    that cell shows as unavailable, not a checkbox pretending otherwise.
//  - SAFETY kinds (dose / escalation) may be turned off per channel, but if one ends
//    up off on EVERY configured channel the row shows an explicit warning — warn,
//    never block (the findings-bus rule: a safety signal is never silently suppressed).

type ChannelId = "telegram" | "push" | "ha";

type Column = {
  id: ChannelId;
  label: string;
  owner: string;
  configured: boolean;
};

export default function NotificationMatrix({
  telegramDisabled,
  pushDisabled,
  haDisabled,
  telegramConfigured,
  pushConfigured,
  haConfigured,
}: {
  telegramDisabled: NotificationKind[];
  pushDisabled: NotificationKind[];
  haDisabled: NotificationKind[];
  telegramConfigured: boolean;
  pushConfigured: boolean;
  haConfigured: boolean;
}) {
  const router = useRouter();
  const [disabled, setDisabled] = useState<
    Record<ChannelId, Set<NotificationKind>>
  >(() => ({
    telegram: new Set(telegramDisabled),
    push: new Set(pushDisabled),
    ha: new Set(haDisabled),
  }));
  const [saving, setSaving] = useState(false);

  const columns: Column[] = [
    {
      id: "telegram",
      label: "Telegram",
      owner: "this login",
      configured: telegramConfigured,
    },
    {
      id: "push",
      label: "Web Push",
      owner: "this login",
      configured: pushConfigured,
    },
    {
      id: "ha",
      label: "Home Assistant",
      owner: "this profile",
      configured: haConfigured,
    },
  ];

  const saver: Record<ChannelId, (fd: FormData) => Promise<unknown>> = {
    telegram: saveLoginTelegramNotifyKinds,
    push: savePushNotifyKinds,
    ha: saveHomeAssistantNotifyKinds,
  };

  // A cell is a real toggle unless the channel inherently can't deliver the kind
  // (only push × food today). An unavailable cell is neither "on" nor a checkbox.
  function cellAvailable(channel: ChannelId, kind: NotificationKind): boolean {
    if (channel === "push") return isPushDeliverableKind(kind);
    return true;
  }

  function enabled(channel: ChannelId, kind: NotificationKind): boolean {
    return !disabled[channel].has(kind);
  }

  async function toggle(channel: ChannelId, kind: NotificationKind) {
    const next = new Set(disabled[channel]);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    const nextState = { ...disabled, [channel]: next };
    setDisabled(nextState);
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("disabled_kinds", serializeDisabledKinds([...next]));
      await saver[channel](fd);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // Whether a safety kind will reach NO configured channel — the warn-never-block
  // case. A channel that can't deliver the kind (push × food, N/A for safety) or is
  // unconfigured doesn't count; only a configured, deliverable channel with the kind
  // ENABLED keeps the row covered.
  function safetyUncovered(kind: NotificationKind): boolean {
    if (!isSafetyKind(kind)) return false;
    const anyConfigured = columns.some((c) => c.configured);
    if (!anyConfigured) return false; // nothing delivers anything — not this row's fault
    const covered = columns.some(
      (c) => c.configured && cellAvailable(c.id, kind) && enabled(c.id, kind)
    );
    return !covered;
  }

  return (
    <div className="card max-w-2xl space-y-4" data-testid="notification-matrix">
      <div>
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Which messages reach me where
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Turn a kind off for a channel and it stops reaching you there (it
          still reaches your other channels). A gated skip is a deliberate
          non-send — it never counts as a delivery failure.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/10 dark:border-white/10">
              <th className="py-2 pr-4 text-left font-medium text-slate-600 dark:text-slate-300">
                Notification
              </th>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className="px-3 py-2 text-center font-medium text-slate-600 dark:text-slate-300"
                >
                  <div>{c.label}</div>
                  <div className="text-xs font-normal text-slate-400">
                    {c.owner}
                    {!c.configured && " · not set up"}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TOGGLEABLE_NOTIFICATION_KINDS.map(({ kind, label }) => {
              const uncovered = safetyUncovered(kind);
              return (
                <tr
                  key={kind}
                  className="border-b border-black/5 dark:border-white/5"
                  data-testid={`matrix-row-${kind}`}
                >
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-200">
                    {label}
                    {uncovered && (
                      <span
                        className="mt-0.5 block text-xs text-rose-600 dark:text-rose-400"
                        data-testid={`matrix-safety-warning-${kind}`}
                      >
                        No channel will deliver this — it&rsquo;s a safety
                        reminder.
                      </span>
                    )}
                  </td>
                  {columns.map((c) => {
                    const available = cellAvailable(c.id, kind);
                    return (
                      <td key={c.id} className="px-3 py-2 text-center">
                        {available ? (
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-brand-600"
                            checked={enabled(c.id, kind)}
                            disabled={saving}
                            onChange={() => toggle(c.id, kind)}
                            data-testid={`matrix-cell-${c.id}-${kind}`}
                            aria-label={`${label} to ${c.label}`}
                          />
                        ) : (
                          <span
                            className="text-slate-300 dark:text-slate-600"
                            title="Web Push can’t deliver this button-only reminder."
                            data-testid={`matrix-unavailable-${c.id}-${kind}`}
                          >
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
