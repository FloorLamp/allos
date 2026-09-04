import { IconAlertTriangle, IconSearch, IconX } from "@tabler/icons-react";
import Link from "next/link";
import Chip from "@/components/Chip";
import SegmentedControl from "@/components/SegmentedControl";
import TrainingLogActions from "./TrainingLogActions";
import TrainingLogCreateOnArrival from "./TrainingLogCreateOnArrival";
import { ACTIVITY_TYPES } from "@/lib/types";
import { trainingLogHref } from "@/lib/hrefs";
import type { TrainingLogQuery } from "@/lib/training-log-format";
import { trainingLogQueryActive } from "@/lib/training-log-format";
import SubmitButton from "@/components/SubmitButton";

// ── THE LOG'S LAYERED REFINEMENTS (#4079) ───────────────────────────────────
//
// A SERVER-RENDERED FORM AND A ROW OF LINKS, not a client filter machine. The
// retired view held four filters in React, debounced a Server Action for page one on
// every change, and reconciled a late response against the filter set the reader was
// by then looking at. A filtered Log is a PLACE: linkable, reloadable, and answerable
// by the server in one pass — so the whole apparatus was buying only the latency a
// form submit already has, and the state it held is now in the URL where the
// substrate's own bound and folds already live.
//
// EVERY CONTROL CARRIES THE WHOLE QUERY, through `trainingLogHref`. That is what
// stops a type chip from silently dropping a search, or a source change from
// resetting a widened bound — three separate bugs the old independent `useState`s
// each had their own guard against.

// `mobility` is deliberately absent — mobility sessions have their own surface — but
// every type a ROW can carry needs a segment, or that row is unfilterable: it renders
// in the feed with a type no control can name. `unclassified` (#2272) is such a type,
// so it gets a segment labelled for what it is.
const TYPE_LABELS: Partial<Record<(typeof ACTIVITY_TYPES)[number], string>> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
  unclassified: "Unspecified",
};

export default function TrainingLogFilterBar({
  query,
  sourceOptions,
  showFault,
  hasHistory,
  day,
  everyone,
  show,
  initialCreateDate,
}: {
  query: TrainingLogQuery;
  sourceOptions: { value: string; label: string }[];
  /** Whether ANY row in view cannot be re-saved as-is. No count (#4079). */
  showFault: boolean;
  /** Whether this profile has any training row at all — see the mount (#809). */
  hasHistory: boolean;
  /** The day this read is bounded to, when a day link brought the reader here. */
  day?: { date: string; label: string };
  everyone: boolean;
  show?: number;
  initialCreateDate?: string;
}) {
  const base = { everyone, show, source: query.source, tag: query.tag };
  const active = trainingLogQueryActive(query);
  const typeSegments = [
    {
      value: "",
      label: "All",
      href: trainingLogHref({ ...query, day: day?.date, type: null }),
    },
    ...ACTIVITY_TYPES.filter((t) => TYPE_LABELS[t] != null).map((t) => ({
      value: t as string,
      label: TYPE_LABELS[t]!,
      href: trainingLogHref({ ...query, day: day?.date, type: t }),
    })),
  ];

  return (
    <div className="mb-4 grid gap-2">
      {initialCreateDate && (
        <TrainingLogCreateOnArrival date={initialCreateDate} />
      )}
      {hasHistory && (
        // ONE WRAPPER FOR THE REFINEMENTS, so "is there anything to filter" is one
        // question with one answer in the DOM (#809): over an empty history there is
        // nothing to search and nothing to narrow, and the controls stand down whole.
        <div data-testid="training-log-controls" className="grid gap-2">
          {/* THE SEARCH IS A GET FORM, so a query is a URL and the back button works.
          The hidden fields carry every other refinement across, for the same reason
          the links above do. */}
          <form
            action="/training"
            method="get"
            data-testid="training-log-search-form"
            className="flex min-w-48 items-center gap-2"
          >
            <input type="hidden" name="tab" value="log" />
            {day && <input type="hidden" name="day" value={day.date} />}
            {query.type && (
              <input type="hidden" name="type" value={query.type} />
            )}
            {base.source && (
              <input type="hidden" name="src" value={base.source} />
            )}
            {query.fault && <input type="hidden" name="fault" value="1" />}
            {base.tag && (
              <input
                type="hidden"
                name="tag"
                value={`${base.tag.kind}:${base.tag.value}`}
              />
            )}
            {everyone && <input type="hidden" name="view" value="everyone" />}
            <div className="relative min-w-0 flex-1">
              <IconSearch
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400"
                stroke={2}
              />
              {/* KEYED ON THE QUERY, so the box always says what the URL says. The
                  field is uncontrolled — `defaultValue` seeds it and the reader
                  types freely — and an uncontrolled input keeps its own `value`
                  PROPERTY across a soft navigation even when React re-renders it
                  with a new `defaultValue`. Clearing every refinement is exactly
                  that navigation: the URL loses `q`, the attribute re-renders to
                  "", and without this key the same DOM node goes on showing the
                  old term over an unfiltered feed. Measured in CI on this branch —
                  `<input value="">` reporting a live value of the cleared search
                  term. The key remounts the field whenever the query changes,
                  which is the only moment its seed is allowed to move. */}
              <input
                key={query.q ?? ""}
                type="search"
                name="q"
                defaultValue={query.q ?? ""}
                aria-label="Search activities or exercises"
                data-testid="training-log-search"
                placeholder="Search activities or exercises…"
                className="input appearance-none pl-9 [&::-webkit-search-cancel-button]:appearance-none"
              />
            </div>
            <SubmitButton>Search</SubmitButton>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            {/* THE DAY BOUND SAYS SO, AND SAYS HOW TO LEAVE. A day link narrows the
                read to one day, which reads as a Log that has lost its history unless
                the page names the bound; this chip is that name, and its href is the
                way back to the whole ledger. Human date shape on the chip, machine
                date in the URL — the day panel's own split. */}
            {day && (
              <Chip
                role="filter"
                href={trainingLogHref({ ...query, everyone, show })}
                current
                testId="training-log-day-filter"
              >
                {day.label}
              </Chip>
            )}
            <SegmentedControl
              options={typeSegments}
              value={query.type ?? ""}
              ariaLabel="Activity type"
              testId="training-log-type-filter"
            />
            {/* Only when there is something to choose between: one provenance is not a
            filter, it is a fact about the ledger. */}
            {sourceOptions.length > 1 && (
              <div
                data-testid="training-log-source-filter"
                className="flex flex-wrap items-center gap-1 text-sm"
              >
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  Source
                </span>
                <Chip
                  role="filter"
                  href={trainingLogHref({
                    ...query,
                    day: day?.date,
                    source: null,
                  })}
                  current={query.source == null}
                >
                  Any
                </Chip>
                {sourceOptions.map((option) => (
                  <Chip
                    key={option.value}
                    role="filter"
                    href={trainingLogHref({
                      ...query,
                      day: day?.date,
                      source: option.value,
                    })}
                    current={query.source === option.value}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            )}
            {/* THE FAULT CHIP LOSES ITS COUNT (#4079). A count on a filter chip states a
            number the reader cannot act on and that the row grammar does not use;
            what matters is whether the filter is reachable at all. */}
            {showFault && (
              <Chip
                role="filter"
                href={trainingLogHref({
                  ...query,
                  day: day?.date,
                  fault: !query.fault,
                })}
                current={query.fault}
                testId="training-log-fault-filter"
              >
                <IconAlertTriangle className="h-4 w-4" stroke={2} />
                Can’t be saved
              </Chip>
            )}
            {query.tag && (
              <Chip
                role="filter"
                href={trainingLogHref({ ...query, day: day?.date, tag: null })}
                current
                testId="training-log-tag-filter"
              >
                {query.tag.value}
              </Chip>
            )}
            {active && (
              <Link
                href={trainingLogHref({ everyone, show })}
                data-testid="training-log-clear-filters"
                className="inline-flex items-center gap-1 px-1 py-1 text-sm font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
              >
                <IconX className="h-3.5 w-3.5" />
                Clear filters
              </Link>
            )}
          </div>
        </div>
      )}
      <TrainingLogActions />
    </div>
  );
}
