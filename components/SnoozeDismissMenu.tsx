"use client";

import { useState } from "react";
import { IconClock, IconEyeOff } from "@tabler/icons-react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";

// Quick-snooze durations offered per item. One list, shared by both surfaces
// that render this menu, so the choices can't drift apart.
const SNOOZE_OPTIONS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

// Per-item snooze/dismiss popover shared by the dashboard "Needs attention" hero
// and the Upcoming page (issue #281). Built on the same OverflowMenu the goal /
// supplement / extracted-record kebabs use, so every popover in the app gets the
// same opaque panel, click-away backdrop, Escape handling, and viewport-aware
// positioning — the old native-<details> version floated a translucent .card and
// never closed on an outside click or after picking an option.
//
// The Server Actions come in as props from the (server-component) caller: both
// surfaces speak the same shared findings-suppression store, but each keeps its
// own action so it revalidates its own paths. Each action reads `signal_key`
// (+ `days` for a snooze) from the submitted FormData.
export default function SnoozeDismissMenu({
  signalKey,
  snoozeAction,
  dismissAction,
}: {
  signalKey: string;
  snoozeAction: (formData: FormData) => Promise<void>;
  dismissAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <OverflowMenu label="Snooze or dismiss" open={open} onOpenChange={setOpen}>
      {({ runAction }) => (
        <>
          <div className="flex items-center gap-1 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <IconClock className="h-3 w-3" stroke={1.75} />
            Snooze
          </div>
          {SNOOZE_OPTIONS.map((opt) => (
            <form
              key={opt.days}
              action={(fd) =>
                runAction(snoozeAction, fd, `Snoozed for ${opt.label}`)
              }
            >
              <input type="hidden" name="signal_key" value={signalKey} />
              <input type="hidden" name="days" value={opt.days} />
              <button type="submit" role="menuitem" className={MENU_ITEM}>
                {opt.label}
              </button>
            </form>
          ))}
          <form
            action={(fd) => runAction(dismissAction, fd, "Dismissed")}
            className="border-t border-black/5 dark:border-white/5"
          >
            <input type="hidden" name="signal_key" value={signalKey} />
            <button
              type="submit"
              role="menuitem"
              className={`${MENU_ITEM} flex items-center gap-1.5`}
            >
              <IconEyeOff className="h-3.5 w-3.5" stroke={1.75} />
              Dismiss
            </button>
          </form>
        </>
      )}
    </OverflowMenu>
  );
}
