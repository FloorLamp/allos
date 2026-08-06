"use client";

import {
  IconBarbell,
  IconChevronRight,
  IconDroplet,
  IconFileText,
  IconHeartbeat,
  IconMoodSmile,
  IconPill,
  IconSalad,
  IconScale,
  IconSparkles,
} from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import { useActivityEditor } from "./ActivityEditorProvider";
import { useQuickEntry } from "./QuickEntryProvider";
import {
  quickLogMenu,
  type QuickLogIcon,
  type QuickLogItem,
} from "@/lib/quick-log";

// The quick-log sheet (issue #1416, section E1): the phone bar's **+** promotes
// ONE contextual action, and the caret beside it opens this — every common log,
// one tap from anywhere.
//
// It creates nothing itself, and since #1468 it NAVIGATES nowhere either: every
// row opens a form in place — the shared activity editor through the
// ActivityEditor context (the same call the bar has always made), or an existing
// quick-add form in the shared quick-entry overlay. So "log from anywhere" now
// also means "and stay where you were", which is the entire point of a quick
// logger. There is still no second write path to keep in sync — the registry in
// lib/quick-log.ts is the only thing that knows which row opens which, and it is
// pure and unit-tested (including that no sheet row is a `navigate` target).

const ICONS: Record<QuickLogIcon, typeof IconBarbell> = {
  barbell: IconBarbell,
  salad: IconSalad,
  pill: IconPill,
  scale: IconScale,
  heartbeat: IconHeartbeat,
  // The glyphs these surfaces already wear: the Wellness nav's sparkles and the
  // search palette's document page.
  sparkles: IconSparkles,
  mood: IconMoodSmile,
  // The glyph the Cycle nav entry and the dashboard phase card already wear (#1892).
  droplet: IconDroplet,
  document: IconFileText,
};

export default function QuickLogSheet({
  open,
  onClose,
  restricted = false,
  cycleRelevant = true,
}: {
  open: boolean;
  onClose: () => void;
  // An age-restricted profile has no training surface, so the activity entry is
  // dropped (lib/quick-log.ts owns that rule).
  restricted?: boolean;
  // The #1042 `cycle` relevance bit, resolved once by the app layout — the SAME bit
  // gating the Cycle nav entry and the dashboard phase widget (#1892).
  cycleRelevant?: boolean;
}) {
  const { openCreate } = useActivityEditor();
  const { open: openQuickEntry } = useQuickEntry();
  const items = quickLogMenu(restricted, cycleRelevant);

  function run(item: QuickLogItem) {
    // Close first: whatever opens next is its own overlay, and stacking a second
    // one under this sheet would leave a locked body scroll behind when the
    // inner surface closes.
    onClose();
    if (item.target.kind === "activity") openCreate();
    else if (item.target.kind === "overlay") openQuickEntry(item.target.form);
    // No `navigate` branch: the registry guarantees no sheet row carries one
    // (#1468), and the exhaustive union makes a future one a compile error here
    // rather than a silent dead row.
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Quick log"
      description="Log it right here — you'll stay on this page."
      testId="quick-log-sheet"
    >
      <ul className="flex flex-col gap-1 pb-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid={`quick-log-${item.id}`}
                onClick={() => run(item)}
                className="tap-target press flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white/70 px-3 py-3 text-left transition hover:bg-slate-100 dark:border-white/10 dark:bg-ink-850 dark:hover:bg-ink-750"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                  <Icon className="h-5 w-5" stroke={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {item.hint}
                  </span>
                </span>
                <IconChevronRight
                  className="h-4 w-4 shrink-0 text-slate-400"
                  stroke={1.75}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
