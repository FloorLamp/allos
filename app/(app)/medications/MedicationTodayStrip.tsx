import { IconPill, IconRefresh } from "@tabler/icons-react";
import Avatar from "@/components/Avatar";
import DoseStatusControl from "@/components/DoseStatusControl";
import type { SubjectInfo } from "@/lib/scope";
import {
  medBoardAnchor,
  medStripMemberHasItems,
  type MedStripMember,
} from "@/lib/medication-multi-view";

// The ONE genuinely cross-member element on the multi-view Medications page (#1373
// point 6): a merged "Today across everyone" strip that leads the boards. It REUSES
// the household page's per-member attention rollup (due doses + low refills — one
// computation, #221/#1108), filtered to medications, and each item jumps to its
// member's board below. Rendered only in multi-view; a member with nothing due is
// dropped (no empty rows). Returns null when the whole household is quiet.
//
// AND A DUE DOSE HERE IS TAKEABLE (#4429). The strip used to be jump links only, so a
// caregiver reading "everyone" had to travel to a board to answer the row they were
// already looking at, while the board beneath offered the very same tap. These are
// FOUND rows on a page the caregiver has already reached — the one-profile-switcher
// ruling is untouched: no subject picker, no acting switch, and the write is gated on
// the TARGET (`setDoseStatus` → requireProfileWriteAccess) exactly as the board's is.
// A read-only-granted member keeps the link and gets no control, which is the same
// per-member reach `MedicationBoard` applies.
export default function MedicationTodayStrip({
  members,
  actingProfileId,
}: {
  members: { subject: SubjectInfo; strip: MedStripMember }[];
  // The acting profile, so a row that IS the actor posts no `profileId` and stays
  // byte-identical to the board's own tap on the same dose (#1373's `confirmProfileId`).
  actingProfileId: number;
}) {
  const active = members.filter((m) => medStripMemberHasItems(m.strip));
  if (active.length === 0) return null;

  return (
    <section
      data-testid="med-today-everyone"
      className="card"
      aria-label="Today across everyone"
    >
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        Today across everyone
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Doses due and low refills across the household — tap one to jump to that
        person’s medications.
      </p>
      <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
        {active.map(({ subject, strip }) => (
          <li
            key={subject.profileId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
            data-testid={`med-everyone-${subject.profileId}`}
          >
            <a
              href={medBoardAnchor(subject.profileId)}
              className="flex shrink-0 items-center gap-1.5 rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              <Avatar
                profile={{
                  id: subject.profileId,
                  name: subject.name,
                  photo_path: subject.photoPath,
                  photo_version: subject.photoVersion,
                }}
                size="sm"
              />
              <span className="text-sm font-medium text-slate-700 hover:underline dark:text-slate-200">
                {subject.name}
              </span>
            </a>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {strip.dueDoses.map((item) => (
                <span
                  key={item.key}
                  className="inline-flex max-w-full items-center gap-1.5"
                >
                  <a
                    href={medBoardAnchor(subject.profileId)}
                    data-testid="med-everyone-due"
                    className="inline-flex max-w-full items-start gap-1 rounded-lg border border-black/10 bg-slate-50 py-1 pl-1.5 pr-2 text-xs font-medium text-slate-600 transition hover:border-brand-400 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
                  >
                    <IconPill className="h-3.5 w-3.5 shrink-0" stroke={1.75} />
                    <span className="min-w-0 wrap-break-word">
                      <span className="block">{item.title}</span>
                      {item.dueText && (
                        <span className="block font-normal opacity-80">
                          {item.dueText}
                        </span>
                      )}
                    </span>
                  </a>
                  {subject.access === "write" && item.doseId != null ? (
                    <DoseStatusControl
                      doseId={item.doseId}
                      taken={false}
                      skipped={false}
                      variant="pill"
                      compact
                      // WHICH DOSE, spoken: this control sits beside a chip in a
                      // household-wide list, so the icon-only arms need the row's own
                      // name in their accessible label (#2615 item 2).
                      itemName={`${item.title} — ${subject.name}`}
                      profileId={
                        subject.profileId === actingProfileId
                          ? undefined
                          : subject.profileId
                      }
                    />
                  ) : null}
                </span>
              ))}
              {strip.lowRefills.map((item) => (
                <a
                  key={item.key}
                  href={medBoardAnchor(subject.profileId)}
                  data-testid="med-everyone-refill"
                  className="inline-flex max-w-full items-start gap-1 rounded-lg border border-amber-200 bg-amber-50/60 py-1 pl-1.5 pr-2 text-xs font-medium text-amber-700 transition hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                >
                  <IconRefresh className="h-3.5 w-3.5 shrink-0" stroke={1.75} />
                  <span className="min-w-0 wrap-break-word">
                    <span className="block">{item.title}</span>
                    {item.detail && (
                      <span className="block font-normal opacity-80">
                        {item.detail}
                      </span>
                    )}
                  </span>
                </a>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
