"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import Chip from "@/components/Chip";
import IntakeItemForm from "@/components/IntakeItemForm";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import { addIntakeItem } from "@/app/(app)/nutrition/intake-actions";
import { medicationHref } from "@/lib/hrefs";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import { medChipsStatusLine, prnRowStatus } from "@/lib/redose-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useDoseOfferLive } from "@/components/illness/DoseOfferContext";

// How many chips stand before the tail folds. Three is what the compact quick-log
// content already showed, so the fold's threshold is unchanged by this rebuild.
const COLLAPSED_CHIPS = 3;

// ── MEDS AS CHIPS, DETAIL ONLY WHEN ACTING (#4752 item 4) ───────────────────
//
// The cockpit drew a full PRN row per medication: name, "None", "Redose OK",
// a Take button and a clock door, three times over — six lines of boilerplate above
// three taps, and on a desktop the names sat a monitor's width from their buttons.
// Collapsed it is a flow row of named chips under ONE status line about the whole
// row ("Nothing given in 24h · both windows open"), with the tail behind "N more".
//
// A CHIP OPENS THE MED; IT DOES NOT GIVE IT. That is deliberate and it is the
// pediatric case deciding it: the collapsed chip shows the medication's NAME, and
// #4753's primitive claims that a chip's label shows the payload its tap carries —
// so a chip that wrote a dose the reader never saw would break the one thing the
// primitive promises. The panel it opens states the dose, that med's own redose
// line, and the weight-band basis once #4713 computes one; the labeled-verb chip
// inside it is the tap that writes, and its label is the dose.
export default function IllnessMedicationLogger({
  meds,
  tz,
  profileId,
  intakeContext,
  canAdd,
  nowIso,
  yieldsTo,
  onLogged,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  profileId?: number;
  // REQUIRED, and the whole of it (#4609). This fold used to pass the pediatric
  // context alone, so the form it mounts knew the profile was a child — weight-band
  // dosing and all — while its food-note age gate ran on "unknown" and its stack, PGx
  // and pairing inputs were empty. A host that cannot supply the subject's full
  // context has no business opening this door.
  intakeContext: IntakeFormContext;
  canAdd: boolean;
  // The server's redose-window "now" (see QuickLogPrnContent.nowIso) — this is a
  // "use client" mount, so the frozen-clock env override is invisible here.
  nowIso: string;
  // THE CHIPS THIS ROW YIELDS TO THE FOLD'S DOSE OFFER (#4712 ruling 2026-09-04 11:20
  // UTC part 2). A persistent Meds section names the antipyretics the fold offers, and
  // those chips step aside WHILE that offer is live — one prompt for one dose. Absent
  // on the fold's own mount and on every host with no offer beside it, which is what
  // keeps this a data prop rather than a mode.
  yieldsTo?: readonly { id: number }[];
  // Fired after a dose is logged from this row. The fold's offer ends on it: "until
  // the offer is taken or dismissed" (same ruling), and taken means the dose landed.
  onLogged?: () => void;
}) {
  const formatPrefs = useFormatPrefs();
  const [adding, setAdding] = useState(false);
  const [openMedId, setOpenMedId] = useState<number | null>(null);
  const [showTail, setShowTail] = useState(false);
  const now = new Date(nowIso);
  const rows = meds.map((med) => ({
    med,
    row: prnRowStatus(med, tz, now, formatPrefs.timeFormat),
  }));
  // THE CHIPS ONLY. `rows` stays the whole row everywhere else it is read: the status
  // line still describes this medication set ("Nothing given in 24h · both windows
  // open"), and the empty-state below still means "this person has no PRNs" rather
  // than "the offer has the only one". A yielded chip is a chip on another surface
  // this instant, not a medication that stopped existing.
  const yielded =
    useDoseOfferLive() && yieldsTo ? new Set(yieldsTo.map((m) => m.id)) : null;
  const standing = yielded
    ? rows.filter((entry) => !yielded.has(entry.med.id))
    : rows;
  const statusLine = medChipsStatusLine(rows.map((entry) => entry.row.status));
  const tail = standing.slice(COLLAPSED_CHIPS);
  const shown = showTail ? standing : standing.slice(0, COLLAPSED_CHIPS);
  // An open panel goes with its chip: the med it names is being offered in the fold,
  // and two `cockpit-med-panel` on one page is the collision this yield exists to end.
  const open = standing.find((entry) => entry.med.id === openMedId);

  return (
    <section data-testid="cockpit-meds">
      <div
        data-testid="cockpit-med-chips"
        className="flex flex-wrap items-center gap-2"
      >
        {shown.map(({ med }) => (
          <Chip
            key={med.id}
            role="filter"
            pressed={med.id === openMedId}
            expanded={med.id === openMedId}
            controls="cockpit-med-panel"
            testId={`cockpit-med-chip-${med.id}`}
            data={{ "data-item-id": med.id }}
            onClick={() =>
              setOpenMedId((current) => (current === med.id ? null : med.id))
            }
          >
            {med.displayName ?? med.name}
          </Chip>
        ))}
        {tail.length > 0 && (
          <Chip
            role="filter"
            pressed={showTail}
            testId="cockpit-med-more"
            onClick={() => setShowTail((v) => !v)}
          >
            {showTail ? "Fewer" : `${tail.length} more`}
          </Chip>
        )}
        {canAdd ? (
          <button
            type="button"
            className="btn-ghost btn-sm"
            data-testid="illness-add-medication"
            aria-expanded={adding}
            aria-controls="illness-medication-quick-add"
            onClick={() => setAdding((open) => !open)}
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 transition-transform ${adding ? "rotate-180" : ""}`}
            />
            Add medication
          </button>
        ) : null}
      </div>

      {meds.length === 0 ? (
        <p
          data-testid="quick-log-prn-empty"
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
          No medications added.
        </p>
      ) : statusLine ? (
        <p
          data-testid="cockpit-med-status"
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
          {statusLine}
        </p>
      ) : null}

      {open ? (
        <div
          id="cockpit-med-panel"
          data-testid="cockpit-med-panel"
          data-item-id={open.med.id}
          className="subpanel-inset-sm mt-2 rounded-lg border border-black/5 p-3 dark:border-white/5"
        >
          {/* IDENTITY RIDES ON THE PANEL (#531): the detail layout deliberately draws
              no name, because on the medications page the card above it already does.
              Here the panel is the only thing on screen naming what a tap will give. */}
          <div className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-100">
            {open.med.kind === "medication" ? (
              <Link href={medicationHref(open.med.id)} className="text-link">
                {open.med.displayName ?? open.med.name}
              </Link>
            ) : (
              (open.med.displayName ?? open.med.name)
            )}
          </div>
          <QuickLogPrnControl
            itemId={open.med.id}
            name={open.med.displayName ?? open.med.name}
            doseAmount={open.med.amount}
            product={open.med.product}
            dayLabel={open.row.dayLabel}
            redoseLine={open.row.redoseLine}
            redosePrimary={open.row.redosePrimary}
            profileId={profileId}
            layout="detail"
            tz={tz}
            onLogged={onLogged}
          />
        </div>
      ) : null}

      {adding ? (
        <div
          id="illness-medication-quick-add"
          data-testid="illness-medication-quick-add"
          className="subpanel-inset-sm mt-2 rounded-lg border border-black/5 p-3 dark:border-white/5"
        >
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            Add an over-the-counter medication and its usual dose.
          </p>
          <IntakeItemForm
            action={addIntakeItem}
            kind="medication"
            allIntakeItems={intakeContext.allIntakeItems}
            stackItems={intakeContext.stackItems}
            pgxVariants={intakeContext.pgxVariants}
            conditions={intakeContext.conditions}
            pediatric={intakeContext.pediatric}
            todayStr={intakeContext.todayStr}
            onDone={() => setAdding(false)}
          />
        </div>
      ) : null}
    </section>
  );
}
