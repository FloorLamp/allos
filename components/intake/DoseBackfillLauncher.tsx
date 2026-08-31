"use client";

import { useState } from "react";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  doseOptionsFor,
  type DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";

// "LOG PAST DOSE" — the dose mount's backfill slot (#2417), which the shared frame
// places but does not define (#3484 part 2).
//
// Backfilling a dose is the most common reason to open a dose ledger at all, so it is
// a TOP-LEVEL entry here rather than something three menus deep behind one item. What
// makes it dose machinery and not frame machinery is everything inside: which items
// can be logged against at all, the course-bound and as-needed gates the form applies,
// and the write itself.
export default function DoseBackfillLauncher({
  loggable,
  maxDate,
  defaultTime,
  defaultItemId,
}: {
  // The items a past dose may be logged against — the mount's rule, applied there:
  // only items with a LIVE dose, so an item whose schedule is entirely retired keeps
  // its history but takes no new rows. A ledger with none of them renders no slot at
  // all rather than an empty one.
  loggable: DoseLedgerItem[];
  maxDate: string;
  defaultTime: string;
  // The item the ledger is currently FILTERED to, if any: a reader who narrowed the
  // table to one item and then tapped "Log past dose" means that item, so the picker
  // opens on it instead of on whatever sorts first. Every item stays selectable.
  defaultItemId?: number;
}) {
  const formatPrefs = useFormatPrefs();
  const [adding, setAdding] = useState(false);
  const [pickedId, setPickedId] = useState<number>(
    (defaultItemId && loggable.some((item) => item.id === defaultItemId)
      ? defaultItemId
      : loggable[0]?.id) ?? 0
  );
  const picked = loggable.find((item) => item.id === pickedId) ?? loggable[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setAdding((value) => !value)}
        className="btn-ghost btn-sm"
        aria-expanded={adding}
        data-testid="dose-ledger-add"
      >
        {/* ONE identity (#3911). Dismissal belongs to the form this opens, whose
            Cancel button closes the whole panel through onDone. */}
        Log past dose
      </button>
      {adding && picked ? (
        <div data-testid="dose-ledger-add-panel">
          {/* Named distinctly from the page's Item FILTER: two controls whose
              accessible name is just "Item" would be indistinguishable to a screen
              reader (and to a spec) on the same page. */}
          <label className="label mt-3 block" htmlFor="dose-ledger-item">
            Item to log against
          </label>
          <select
            id="dose-ledger-item"
            className="input"
            value={picked.id}
            data-testid="dose-ledger-item-picker"
            onChange={(event) => setPickedId(Number(event.target.value))}
          >
            {loggable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {/* Keyed on the item so switching the picker RESETS the form's dose, amount
              and date state — a form seeded from a different item would otherwise
              carry that item's dose id into this one's write. */}
          <HistoricalDoseForm
            key={picked.id}
            itemId={picked.id}
            itemName={picked.name}
            doses={doseOptionsFor(picked, formatPrefs)}
            maxDate={maxDate}
            defaultTime={defaultTime}
            asNeeded={picked.asNeeded}
            courseBound={picked.kind === "medication"}
            onDone={() => setAdding(false)}
          />
        </div>
      ) : null}
    </>
  );
}
