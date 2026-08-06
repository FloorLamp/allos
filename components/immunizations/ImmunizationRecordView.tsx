import {
  DEFAULT_FORMAT_PREFS,
  formatDateWithYear,
  formatTimestamp,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { immunizationRouteLabel } from "@/lib/record-format";
import NotesText from "@/components/NotesText";
import {
  immunizationRecordDoseCount,
  type ImmunizationRecordGroup,
} from "@/lib/immunization-record";

// The printable immunization record (issue #1849), rendered identically for the
// printable page and the tokenized /share view — both format over the SAME
// buildImmunizationRecord groups (one computation), exactly as MedicationListView
// serves the medication list's two surfaces. A pure/server component (no
// "use client"), so it renders the same server-side and inside the share page.
// Print-legible from dark mode: the @media print block in globals.css forces
// black-on-white, and the layout uses plain bordered rows, not frosted surfaces.
//
// Every unstated administration fact prints an em dash. That is the point of the
// artifact: a registrar copying a lot number onto a form must be able to see that
// the lot was never recorded, rather than read a plausible-looking guess.

function Cell({ value }: { value: string | null }) {
  return <td className="td">{value ?? "—"}</td>;
}

export default function ImmunizationRecordView({
  personName,
  birthdate,
  generatedAt,
  groups,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  personName: string;
  // YYYY-MM-DD, or null when the profile has no date of birth on file — the one
  // identifier every immunization form asks for beside the name.
  birthdate: string | null;
  generatedAt: string;
  groups: ImmunizationRecordGroup[];
  // Login-tier date shape (#964). The print page passes the viewer's prefs; the
  // tokenized /share view has no login in context and keeps the fixed default.
  formatPrefs?: DisplayFormatPrefs;
}) {
  const generatedLabel = Number.isNaN(new Date(generatedAt).getTime())
    ? null
    : formatTimestamp(generatedAt, formatPrefs);
  const doseCount = immunizationRecordDoseCount(groups);

  return (
    <div
      data-testid="immunization-record-view"
      className="text-slate-800 dark:text-slate-100"
    >
      <header className="mb-4">
        <h1 className="text-xl font-semibold">{personName}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Immunization record
          {birthdate
            ? ` · DOB ${formatDateWithYear(birthdate, formatPrefs)}`
            : ""}
        </p>
        {generatedLabel && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Generated {generatedLabel} · {doseCount}{" "}
            {doseCount === 1 ? "dose" : "doses"} across {groups.length}{" "}
            {groups.length === 1 ? "vaccine" : "vaccines"}
          </p>
        )}
      </header>

      {groups.length === 0 ? (
        <p
          data-testid="immunization-record-empty"
          className="text-sm text-slate-500 dark:text-slate-400"
        >
          No immunization doses recorded.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section
              key={g.code}
              data-testid="immunization-record-group"
              data-vaccine={g.code}
              className="break-inside-avoid"
            >
              <h2 className="mb-1 font-semibold">{g.name}</h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="section-label border-b border-black/15 text-left dark:border-white/15">
                      <th className="th">Date</th>
                      <th className="th">Dose</th>
                      <th className="th">Product</th>
                      <th className="th">Lot</th>
                      <th className="th">Route</th>
                      <th className="th">Site</th>
                      <th className="th">Administered by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.doses.map((d) => (
                      <tr
                        key={d.id}
                        data-testid="immunization-record-dose"
                        className="border-b border-black/10 align-top dark:border-white/10"
                      >
                        <td className="td whitespace-nowrap">
                          {formatDateWithYear(d.date, formatPrefs)}
                        </td>
                        <Cell value={d.label} />
                        <Cell value={d.product ?? g.name} />
                        <Cell value={d.lot} />
                        <Cell value={immunizationRouteLabel(d.route)} />
                        <Cell value={d.site} />
                        <Cell value={d.provider} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {g.doses.some((d) => d.reaction) && (
                <ul className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                  {g.doses
                    .filter((d) => d.reaction)
                    .map((d) => (
                      <li key={d.id}>
                        Reaction ({formatDateWithYear(d.date, formatPrefs)}):{" "}
                        <NotesText notes={d.reaction} />
                      </li>
                    ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      <p className="mt-5 text-xs text-slate-500 dark:text-slate-400">
        Self-reported record — verify against the administering clinic&rsquo;s
        documentation before it is accepted as official proof.
      </p>
    </div>
  );
}
