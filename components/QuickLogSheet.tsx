"use client";

import { useRouter } from "next/navigation";
import {
  IconBarbell,
  IconChevronRight,
  IconPill,
  IconSalad,
  IconScale,
} from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import { useActivityEditor } from "./ActivityEditorProvider";
import {
  quickLogMenu,
  type QuickLogIcon,
  type QuickLogItem,
} from "@/lib/quick-log";

// The quick-log sheet (issue #1416, section E1): the phone bar's **+** promotes
// ONE contextual action, and the caret beside it opens this — every common log,
// one tap from anywhere.
//
// It creates nothing itself. Each row either opens the shared activity editor
// through the ActivityEditor context (the same call the bar has always made) or
// navigates to the EXISTING create surface, so there is no second write path to
// keep in sync — the registry in lib/quick-log.ts is the only thing that knows
// which is which, and it is pure and unit-tested.

const ICONS: Record<QuickLogIcon, typeof IconBarbell> = {
  barbell: IconBarbell,
  salad: IconSalad,
  pill: IconPill,
  scale: IconScale,
};

export default function QuickLogSheet({
  open,
  onClose,
  restricted = false,
}: {
  open: boolean;
  onClose: () => void;
  // An age-restricted profile has no training surface, so the activity entry is
  // dropped (lib/quick-log.ts owns that rule).
  restricted?: boolean;
}) {
  const router = useRouter();
  const { openCreate } = useActivityEditor();
  const items = quickLogMenu(restricted);

  function run(item: QuickLogItem) {
    // Close first: the activity editor is its own overlay, and navigating with
    // the sheet still mounted would leave a locked body scroll behind.
    onClose();
    if (item.target.kind === "activity") openCreate();
    else router.push(item.target.href);
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Quick log"
      description="Jump straight to the form for what you're recording."
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
