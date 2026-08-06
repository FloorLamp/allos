"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconArrowRight,
  IconCalendarPlus,
  IconCircleMinus,
  IconCircleX,
  IconClipboardPlus,
  type TablerIcon,
} from "@tabler/icons-react";
import OverflowMenu, {
  MENU_ITEM,
  type MenuActionResult,
  type MenuHelpers,
} from "@/components/OverflowMenu";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import {
  SnoozeDismissItems,
  type SnoozeDismissProps,
} from "@/components/SnoozeDismissMenu";
import { type AppRoute } from "@/lib/hrefs";

// ---------------------------------------------------------------------------
// The Upcoming row's SECONDARY actions — one model, two presentations (#1446).
//
// A row's inline controls ("Book", "Mark taken", "Mark done", "Add to
// conditions") are chips at `sm`+ and fold into the row's single overflow menu
// below `sm`, where five free-wrapping chips used to break the row apart (the
// census found cards whose only trailing content on a wrapped line was an
// orphaned "⋯"). Chips and menu items are genuinely different presentations, so
// they can't be ONE element behind a responsive class — but they must never be
// two hand-mirrored authorings either (the responsive-surfaces rule). So the
// caller builds ONE `RowAction[]` and the two presenters below — deliberately
// kept in this single file, beside each other — are pure formatters over it.
// Adding a row action means adding one descriptor; both viewports get it.
// ---------------------------------------------------------------------------

// Icons can't cross the server/client boundary as component references, so a
// descriptor names its icon and each presenter resolves it through this map.
const ACTION_ICON: Record<string, TablerIcon> = {
  book: IconCalendarPlus,
  "arrow-right": IconArrowRight,
  "clipboard-plus": IconClipboardPlus,
};

export type RowAction =
  | {
      id: string;
      kind: "link";
      label: string;
      href: AppRoute;
      icon?: keyof typeof ACTION_ICON;
      testId?: string;
    }
  | {
      id: string;
      kind: "submit";
      label: string;
      icon?: keyof typeof ACTION_ICON;
      testId?: string;
      // Fallback toast when the action resolves void from the folded menu. (A chip
      // run's default feedback stays SubmitButton's pending state + revalidation.)
      toast: string;
      // Hidden form fields posted with the action — ids only, never objects.
      fields: Record<string, string | number>;
      // May resolve a MenuActionResult (#2140): a typed refusal toasts its error in
      // BOTH presentations instead of the row silently re-rendering unchanged, and a
      // success may carry outcome-named wording. `void` keeps the additive default.
      action: (formData: FormData) => Promise<MenuActionResult>;
    };

const CHIP =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750";

function HiddenFields({ fields }: { fields: Record<string, string | number> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

// Presentation 1 — inline chips. When `fold` is set they render at `sm`+ only and
// the same descriptors reappear as menu items below `sm` (see RowActionMenuItems).
// A row whose menu would hold NOTHING ELSE doesn't get a menu at all (there'd be
// nothing behind the kebab at desktop width), so its chips stay inline at every
// width — `fold` is false and this is their only rendering.
export function RowActionChips({
  actions,
  fold,
}: {
  actions: RowAction[];
  fold: boolean;
}) {
  const toast = useToast();
  // An inline chip's default feedback is the pending state + revalidation, but a
  // TYPED result is never discarded (#2140): a refusal toasts its error (the row
  // re-rendering unchanged must not be indistinguishable from a lost tap), and a
  // success that carries outcome-named wording shows it.
  const runChipAction = async (a: RowAction & { kind: "submit" }, fd: FormData) => {
    let result: MenuActionResult;
    try {
      result = await a.action(fd);
    } catch {
      toast("Couldn't complete that action. Try again.", { tone: "error" });
      return;
    }
    if (result && result.ok === false) {
      toast(result.error, { tone: "error" });
      return;
    }
    if (result && result.message) toast(result.message);
  };
  if (actions.length === 0) return null;
  return (
    <div
      className={
        fold ? "hidden items-center gap-1 sm:flex" : "flex items-center gap-1"
      }
    >
      {actions.map((a) => {
        const Icon = a.icon ? ACTION_ICON[a.icon] : null;
        if (a.kind === "link") {
          return (
            <Link
              key={a.id}
              href={a.href}
              data-testid={a.testId}
              className={CHIP}
            >
              {Icon && <Icon className="h-3.5 w-3.5" stroke={1.75} />}
              {a.label}
            </Link>
          );
        }
        return (
          <form
            key={a.id}
            action={(fd) => runChipAction(a, fd)}
            className="shrink-0"
          >
            <HiddenFields fields={a.fields} />
            <SubmitButton
              pendingLabel="…"
              data-testid={a.testId}
              className={CHIP}
            >
              {Icon && <Icon className="h-3.5 w-3.5" stroke={1.75} />}
              {a.label}
            </SubmitButton>
          </form>
        );
      })}
    </div>
  );
}

// Presentation 2 — the same descriptors as menu items, shown only below `sm`
// (where the chips are hidden). The wrapper carries the breakpoint so an open
// menu at desktop width never doubles up an action the row already shows.
function RowActionMenuItems({
  actions,
  runAction,
}: {
  actions: RowAction[];
  runAction: MenuHelpers["runAction"];
}) {
  if (actions.length === 0) return null;
  return (
    <div className="border-b border-black/5 pb-1 sm:hidden dark:border-white/5">
      {actions.map((a) => {
        const Icon = a.icon ? ACTION_ICON[a.icon] : null;
        if (a.kind === "link") {
          return (
            <Link
              key={a.id}
              href={a.href}
              role="menuitem"
              className={`${MENU_ITEM} flex items-center gap-1.5`}
            >
              {Icon && <Icon className="h-3.5 w-3.5" stroke={1.75} />}
              {a.label}
            </Link>
          );
        }
        return (
          <form key={a.id} action={(fd) => runAction(a.action, fd, a.toast)}>
            <HiddenFields fields={a.fields} />
            <button
              type="submit"
              role="menuitem"
              className={`${MENU_ITEM} flex items-center gap-1.5`}
            >
              {Icon && <Icon className="h-3.5 w-3.5" stroke={1.75} />}
              {a.label}
            </button>
          </form>
        );
      })}
    </div>
  );
}

// The preventive "hide this rule" overrides (issue #82), as menu items. They used
// to own a whole second OverflowMenu next to the snooze/dismiss one, which is why
// every preventive row rendered two identical "⋯" triggers (#1446).
function PreventiveOverrideItems({
  ruleKey,
  overrideAction,
  runAction,
}: {
  ruleKey: string;
  overrideAction: (formData: FormData) => Promise<void>;
  runAction: MenuHelpers["runAction"];
}) {
  return (
    <div className="border-b border-black/5 pb-1 dark:border-white/5">
      <form
        action={(fd) => runAction(overrideAction, fd, "Marked not applicable")}
      >
        <input type="hidden" name="rule_key" value={ruleKey} />
        <input type="hidden" name="kind" value="not_applicable" />
        <button
          type="submit"
          role="menuitem"
          className={`${MENU_ITEM} flex items-center gap-1.5`}
        >
          <IconCircleMinus className="h-3.5 w-3.5" stroke={1.75} />
          Not applicable
        </button>
      </form>
      <form action={(fd) => runAction(overrideAction, fd, "Marked declined")}>
        <input type="hidden" name="rule_key" value={ruleKey} />
        <input type="hidden" name="kind" value="declined" />
        <button
          type="submit"
          role="menuitem"
          className={`${MENU_ITEM} flex items-center gap-1.5`}
        >
          <IconCircleX className="h-3.5 w-3.5" stroke={1.75} />
          Declined
        </button>
      </form>
    </div>
  );
}

// THE per-row overflow menu — exactly one "⋯" per Upcoming row, always (#1446).
// It composes everything a row can offer behind a kebab: the folded secondary
// actions (below `sm`), the preventive overrides, and snooze/dismiss.
export default function UpcomingRowMenu({
  folded,
  preventiveRuleKey,
  overrideAction,
  suppression,
}: {
  folded: RowAction[];
  preventiveRuleKey?: string;
  overrideAction?: (formData: FormData) => Promise<void>;
  suppression: SnoozeDismissProps | null;
}) {
  const [open, setOpen] = useState(false);
  const hasPreventive = preventiveRuleKey != null && overrideAction != null;
  // The menu exists only when it has content at EVERY width. A row whose menu
  // would hold nothing but the phone-folded chips gets no menu — rendering a
  // trigger that is CSS-hidden at desktop would still put it in the DOM (and in
  // any "exactly one ⋯ per row" count); that row's caller keeps its chips inline
  // at all widths instead.
  if (!hasPreventive && suppression == null) return null;
  return (
    <OverflowMenu
      // One honest label for the row kebab. It can hold overrides, snooze/dismiss
      // and (on phones) the folded chips, so it is named for the affordance rather
      // than for any one of its sections.
      label="More actions"
      open={open}
      onOpenChange={setOpen}
    >
      {({ runAction }) => (
        <>
          <RowActionMenuItems actions={folded} runAction={runAction} />
          {hasPreventive && (
            <PreventiveOverrideItems
              ruleKey={preventiveRuleKey}
              overrideAction={overrideAction}
              runAction={runAction}
            />
          )}
          {suppression && (
            <SnoozeDismissItems {...suppression} runAction={runAction} />
          )}
        </>
      )}
    </OverflowMenu>
  );
}
