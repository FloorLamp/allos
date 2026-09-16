"use client";

import { IconChevronDown } from "@tabler/icons-react";
import Avatar from "@/components/Avatar";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { CREATE_ACTIONS } from "@/components/CreateAction";
import { bristolScaleLines } from "@/lib/bristol-stool";
import { logHeading } from "@/lib/log-manifest";
import type { OverlaySize } from "@/components/overlay";
import type { QuickEntryForm } from "@/lib/quick-log";
import type { IntakeItemKind } from "@/lib/types";
import type { SessionProfile } from "@/lib/auth";

// ── THE QUICK-ENTRY SHEET'S CHROME ───────────────────────────────────────────
//
// Everything the panel says AROUND the body: the title it prints, how wide it gets,
// the sentence behind its info glyph, and the title row that renders that glyph
// beside who the entry is being logged for.
//
// One `BottomSheet` mounts every quick-entry body, and `QuickEntryProvider` mounts it
// twice — once for a VISIT (the phone sheet's back-stack) and once DIRECTLY (the
// palette, a keyboard shortcut, the desktop panel). Both read this file, which is why
// the two mounts cannot drift into two vocabularies for the same form; the registry
// below is the single answer and the provider only chooses where to render it.
//
// Moved out of components/QuickEntryProvider.tsx verbatim. That file is the visit and
// gather owner and is long enough that its chrome was hard to find inside it; nothing
// here changed in the move, which the relocation control in the PR records.

// WHAT THIS FILE READS OFF A SESSION, and nothing more. `QuickEntrySession` is the
// provider's own record and stays there — these are the four fields the chrome
// actually consults, declared structurally so the dependency runs one way.
export interface SheetChromeEntry {
  form: QuickEntryForm;
  // An intake door standing OVER the body takes the door's own noun (see
  // `sheetForEntry`); anything else is the form's own entry in the registry.
  view: { kind: "body" } | { kind: "intake"; intakeKind: IntakeItemKind };
}

export interface SubjectPickerEntry {
  subject: number;
  pickerOpen: boolean;
}

export interface TitleRowEntry extends SheetChromeEntry, SubjectPickerEntry {}

// The sheet's visible and accessible name per form, and how wide its panel gets
// from `sm` up. Bodies render content beneath that shared title.
//
// THE SIZE IS DECLARED PER FORM, NOT PER HOST (#4977 item 1). One `BottomSheet`
// mounts every body in this registry, so a width set on the mount below is a width
// set for all of them — and the bodies genuinely differ: a dose list is a column of
// rows, the measurements grid is a multi-column tool. #2774's three buckets are the
// vocabulary for exactly that difference, so each form names the one its content is,
// here, beside the title it already names. Every entry but `measurements` declares
// `sm`, which is the sheet's historical default and therefore the width each of them
// renders at today; measurements declares `lg`, the bucket
// `OVERLAY_PANEL_MAX_WIDTH`'s own note already assigns to "the measurements grid".
// THE CHROME ONE FORM DECLARES: its title, how wide its panel gets, and — where the
// body's instrument has a vocabulary a reader cannot see — the sentence behind the
// title row's info glyph (#5756). Named once because three places used to spell it.
export type SheetChrome = { title: string; size: OverlaySize; help?: string };

const SHEET: Record<QuickEntryForm, SheetChrome> = {
  food: { title: logHeading("food"), size: "sm" },
  // #1486/#1506: weight and vitals merged into ONE form (and one sheet row).
  // #3361: the form renders body content, so the sheet prints its heading.
  //
  // `lg` (#4977 item 1): the form's grid is INTRINSIC since #2014 — it asks its
  // container (`repeat(auto-fit, minmax(10.5rem, 1fr))`) rather than the window — so
  // the only thing standing between this mount and the two-row Vitals group the
  // Trends modal already renders was a container that never said how wide it was.
  // Nothing in the form changes; it flows to four fields a row on its own.
  measurements: { title: logHeading("body"), size: "lg" },
  dose: { title: logHeading("dose"), size: "sm" },
  practice: { title: logHeading("practice"), size: "sm" },
  // #1892: the sheet's period row. The panel owns no heading — the verb is on the
  // button, which is the point.
  cycle: { title: "Log period", size: "sm" },
  // #2130: the sheet's mood row — the same check-in write, a second mount.
  mood: { title: logHeading("mood"), size: "sm" },
  // #2785: the sheet's stool row. The panel owns no heading — the seven buttons ARE
  // the question, and a printed one above them would say it twice.
  stool: { title: logHeading("stool"), size: "sm", help: bristolScaleLines() },
  // #3327: the sheet's substance row. The panel owns no heading — the rows ARE the
  // question, and each carries its own verb.
  substance: { title: logHeading("substance"), size: "sm" },
  // #4064: the sheet's symptom row. The panel owns no heading — the bar's own
  // "Daily symptoms" label is suppressed the way the illness cockpit suppresses it,
  // so the sheet prints the one heading.
  symptom: { title: logHeading("symptom"), size: "sm" },
  document: { title: "Add document", size: "sm" },
};

export function sheetForEntry(entry: SheetChromeEntry): SheetChrome {
  // THE SAME NOUN THE TRIGGER CARRIES (#5300 rule 6). This spelled "Add medication"
  // and "Add supplement" itself, which is the create registry's own copy — a second
  // vocabulary for two forms that already had one, and `IntakeItemKind`'s two members
  // are exactly two of its kinds.
  return entry.view.kind === "intake"
    ? { title: CREATE_ACTIONS[entry.view.intakeKind].label, size: "lg" }
    : SHEET[entry.form];
}

// THE SHEET'S TITLE ROW, right of the heading: the form's own instrument vocabulary
// where it has one, then who this entry is being logged for.
//
// THE GLYPH IS THE REGISTRY'S, NOT THIS COMPONENT'S (#5756). A body whose control is
// the question — the stool tiles are seven pictures — has a sentence per option that a
// sighted reader could reach nowhere: the tiles carry it as their accessible name, the
// record's select prints it, and the one surface where a person PICKS a type showed
// pictures. `SheetChrome.help` is where a form says it has such a sentence, and the
// glyph is the design system's existing "short explanation or hidden full value" row
// rather than a description on tap — the tap is the write (#2642).
export function QuickEntryTitleAdornment({
  session,
  writableProfiles,
  onToggle,
}: {
  session: TitleRowEntry;
  writableProfiles: SessionProfile[];
  onToggle: () => void;
}) {
  const { help } = sheetForEntry(session);
  const subjectInfo = writableProfiles.find((p) => p.id === session.subject);
  return (
    <>
      {help ? (
        <InfoTooltipIcon label={help} data-testid="quick-entry-help" />
      ) : null}
      {subjectInfo == null ? null : writableProfiles.length <= 1 ? (
        <span
          data-testid="quick-entry-subject-chip"
          className="inline-flex min-w-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
        >
          <Avatar profile={subjectInfo} size="sm" />
          <span className="truncate">{subjectInfo.name}</span>
        </span>
      ) : (
        <button
          type="button"
          data-testid="quick-entry-subject-chip"
          aria-expanded={session.pickerOpen}
          aria-label={`Logging for ${subjectInfo.name}. Change who this is for.`}
          onClick={onToggle}
          className="inline-flex min-w-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-1.5 text-xs font-medium text-slate-600 hover:border-black/20 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:border-white/20"
        >
          <Avatar profile={subjectInfo} size="sm" />
          <span className="truncate">{subjectInfo.name}</span>
          <IconChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform dark:text-slate-400 ${
              session.pickerOpen ? "rotate-180" : ""
            }`}
            aria-hidden
          />
        </button>
      )}
    </>
  );
}

export function QuickEntrySubjectPicker({
  session,
  writableProfiles,
  onSelect,
}: {
  session: SubjectPickerEntry;
  writableProfiles: SessionProfile[];
  onSelect: (profileId: number) => void;
}) {
  if (!session.pickerOpen || writableProfiles.length <= 1) return null;
  return (
    <div
      data-testid="quick-entry-subject-picker"
      className="mb-2 rounded-lg border border-(--border) bg-surface p-2"
    >
      <p className="mb-1.5 px-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        Who is this for?
      </p>
      <ul className="flex flex-col gap-0.5">
        {writableProfiles.map((profile) => (
          <li key={profile.id}>
            <button
              type="button"
              data-testid={`quick-entry-subject-option-${profile.id}`}
              aria-current={profile.id === session.subject ? "true" : undefined}
              onClick={() => onSelect(profile.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                profile.id === session.subject
                  ? "bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-850"
              }`}
            >
              <Avatar profile={profile} size="sm" />
              <span className="truncate">{profile.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
