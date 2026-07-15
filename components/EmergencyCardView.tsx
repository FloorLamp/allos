import {
  IconAlertTriangle,
  IconPill,
  IconStethoscope,
  IconDroplet,
  IconPhone,
} from "@tabler/icons-react";
import { isEmergencyCardEmpty, type EmergencyCard } from "@/lib/emergency-card";

// Presentational, DOM-only render of the Emergency Card (issue #42). No hooks and
// no "use client" directive, so it renders identically on the server (the
// authenticated /emergency page) and inside a client component (the /offline
// fallback that reads it from localStorage). Deliberately terse and high-contrast:
// a stranger or first responder must be able to read it in a hurry, on paper or a
// locked-out phone. The print stylesheet (print: utilities) drops chrome and forces
// black-on-white.

const SEX_LABEL: Record<string, string> = { male: "Male", female: "Female" };

// generatedAt is an ISO-8601 UTC string (new Date().toISOString()); render it
// deterministically (no locale/timezone) so the server render and client hydration
// can't disagree, and a paper copy is unambiguous.
function formatAsOf(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function Section({
  title,
  icon: Icon,
  accent,
  children,
  testid,
}: {
  title: string;
  icon: typeof IconPill;
  accent: string;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <section
      data-testid={testid}
      className="rounded-xl border border-black/10 bg-white/80 p-4 print:border-black dark:border-white/10 dark:bg-ink-900/60 print:dark:bg-white"
    >
      <h2
        className={`mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide ${accent} print:text-black`}
      >
        <Icon className="h-4 w-4 shrink-0 print:hidden" stroke={2} />
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function EmergencyCardView({ card }: { card: EmergencyCard }) {
  const empty = isEmergencyCardEmpty(card);
  return (
    <div
      data-testid="emergency-card"
      className="mx-auto max-w-2xl space-y-4 print:max-w-none print:text-black"
    >
      {/* Identity banner */}
      <div className="rounded-xl border-2 border-rose-500/60 bg-rose-50 p-4 print:border-black print:bg-white dark:bg-rose-950/30">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-widest text-rose-600 print:text-black dark:text-rose-400">
              Emergency Medical Card
            </p>
            <p
              data-testid="emergency-name"
              className="truncate text-2xl font-extrabold text-slate-900 dark:text-slate-50 print:text-black"
            >
              {card.name}
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300 print:text-black">
              {[
                card.age != null ? `${card.age} yrs` : null,
                card.sex ? SEX_LABEL[card.sex] : null,
                card.birthdate ? `DOB ${card.birthdate}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "No demographics recorded"}
            </p>
          </div>
          {card.bloodType && (
            <div
              data-testid="emergency-blood-type"
              className="flex shrink-0 flex-col items-center rounded-lg border-2 border-rose-500/60 bg-white px-3 py-1.5 print:border-black dark:bg-ink-900"
            >
              <IconDroplet
                className="h-4 w-4 text-rose-600 dark:text-rose-400 print:hidden"
                stroke={2}
              />
              <span className="text-xs font-medium text-slate-500 print:text-black dark:text-slate-400">
                Blood
              </span>
              <span className="text-xl font-extrabold text-slate-900 dark:text-slate-50 print:text-black">
                {card.bloodType}
              </span>
            </div>
          )}
        </div>
      </div>

      {empty && (
        <p
          data-testid="emergency-empty"
          className="rounded-xl border border-black/10 bg-white/80 p-4 text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400"
        >
          No allergies, medications, conditions, blood type, or emergency
          contact are recorded yet. Add them in the Medical section and Settings
          → Profile, then reopen this card while online to refresh the offline
          copy.
        </p>
      )}

      <Section
        title={`Allergies${card.allergies.length ? ` (${card.allergies.length})` : ""}`}
        icon={IconAlertTriangle}
        accent="text-rose-600 dark:text-rose-400"
        testid="emergency-allergies"
      >
        {card.allergies.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400 print:text-black">
            None recorded
          </p>
        ) : (
          <ul className="space-y-1.5">
            {card.allergies.map((a, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-x-2 text-sm print:text-black"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100 print:text-black">
                  {a.substance}
                </span>
                {a.severity && (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700 print:bg-white print:text-black dark:bg-rose-950/50 dark:text-rose-300">
                    {a.severity}
                  </span>
                )}
                {a.reaction && (
                  <span className="text-slate-600 dark:text-slate-300 print:text-black">
                    {a.reaction}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Medications${card.medications.length ? ` (${card.medications.length})` : ""}`}
        icon={IconPill}
        accent="text-brand-600 dark:text-brand-400"
        testid="emergency-medications"
      >
        {card.medications.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400 print:text-black">
            None recorded
          </p>
        ) : (
          <ul className="space-y-1.5">
            {card.medications.map((m, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-x-2 text-sm print:text-black"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100 print:text-black">
                  {m.name}
                </span>
                {m.detail && (
                  <span className="text-slate-600 dark:text-slate-300 print:text-black">
                    {m.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Conditions${card.conditions.length ? ` (${card.conditions.length})` : ""}`}
        icon={IconStethoscope}
        accent="text-amber-600 dark:text-amber-400"
        testid="emergency-conditions"
      >
        {card.conditions.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400 print:text-black">
            None recorded
          </p>
        ) : (
          <ul className="space-y-1.5">
            {card.conditions.map((c, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-x-2 text-sm print:text-black"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100 print:text-black">
                  {c.name}
                </span>
                {c.onsetDate && (
                  <span className="text-xs text-slate-500 dark:text-slate-400 print:text-black">
                    since {c.onsetDate}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {card.contact && (
        <Section
          title="Emergency Contact"
          icon={IconPhone}
          accent="text-emerald-600 dark:text-emerald-400"
          testid="emergency-contact"
        >
          <p className="text-sm print:text-black">
            <span className="font-semibold text-slate-900 dark:text-slate-100 print:text-black">
              {card.contact.name || "Contact"}
            </span>
            {card.contact.relation && (
              <span className="text-slate-500 dark:text-slate-400 print:text-black">
                {" "}
                ({card.contact.relation})
              </span>
            )}
          </p>
          {card.contact.phone && (
            <a
              href={`tel:${card.contact.phone.replace(/[^\d+]/g, "")}`}
              className="text-lg font-bold text-emerald-700 underline-offset-2 hover:underline print:text-black dark:text-emerald-300"
            >
              {card.contact.phone}
            </a>
          )}
        </Section>
      )}

      <p
        data-testid="emergency-asof"
        className="pt-1 text-center text-xs text-slate-500 dark:text-slate-400 print:text-black"
      >
        As of {formatAsOf(card.generatedAt)}. This is a self-reported summary,
        not a complete medical record — verify against the patient when
        possible.
      </p>
    </div>
  );
}
