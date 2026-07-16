import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { MedicalValue } from "@/components/ui";
import { NOTICE_TONE } from "@/components/Notice";
import { fmtWeight } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";
import { isFieldInScope, type ShareField } from "@/lib/share-links";
import type { ProfileSummary } from "@/lib/profile-summary";
import { ordinalPercentile } from "@/lib/growth-format";
import { statusBadgeParts } from "@/lib/immunization-status-ui";

// The shared, presentational "medical passport". Rendered verbatim
// by BOTH the authenticated page (app/(app)/profile) and the unauthenticated
// share render (app/share/[token]) — one component, so the two surfaces can't
// drift. It is pure markup (no hooks, no server-only APIs, no navigation), which
// is what makes it safe to serve to a logged-out viewer.
//
//   - `fields = "all"` shows every section (the owner's own view). A ShareField[]
//     restricts it to the link's allow-list: out-of-scope sections aren't rendered
//     at all, so a share link truly can't leak a section it didn't grant.
//   - `mode = "share"` adds the watermark + expiry banner and swaps the empty-state
//     copy (a logged-out viewer gets no "add it in Settings" nudges).

type Scope = ShareField[] | "all";

function inScope(fields: Scope, field: ShareField): boolean {
  return fields === "all" || isFieldInScope(fields, field);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none">
      <h2 className="mb-3 section-label">{title}</h2>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="section-label">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub != null && (
        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {sub}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
  );
}

// A pediatric growth-percentile pill (e.g. "Weight 40th"), shown on the passport
// Body section for a child in WHO/CDC chart range.
function GrowthBadge({
  label,
  percentile,
}: {
  label: string;
  percentile: number;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
      <span className="uppercase tracking-wide text-brand-500 dark:text-brand-400">
        {label}
      </span>
      <span className="font-semibold">{ordinalPercentile(percentile)} pct</span>
    </span>
  );
}

export default function ProfilePassport({
  summary,
  profile,
  weightUnit,
  fields = "all",
  mode = "app",
  generatedAt,
  expiresAt,
}: {
  summary: ProfileSummary;
  profile: AvatarProfile;
  weightUnit: WeightUnit;
  fields?: Scope;
  mode?: "app" | "share";
  generatedAt: string;
  expiresAt?: string;
}) {
  const { identity, body } = summary;
  const showBody = inScope(fields, "body");
  const hasBody =
    body.heightCm != null ||
    body.weightKg != null ||
    body.bmi != null ||
    body.bodyFatPct != null ||
    body.restingHr != null;

  return (
    <div className="flex flex-col gap-4">
      {mode === "share" && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${NOTICE_TONE.amber}`}
        >
          <div className="font-semibold uppercase tracking-wide">
            Shared read-only copy — not an official medical record
          </div>
          <div className="mt-1 text-amber-800 dark:text-amber-300">
            Generated {fmtDate(generatedAt)}
            {expiresAt ? ` · Access expires ${fmtDate(expiresAt)}` : ""}. This
            summary is provided by the individual and may be incomplete.
          </div>
        </div>
      )}

      {/* Card grid. On the widest breakpoint the cards flow two-up (CSS
          columns → a masonry flow that lets varying-height cards pack without
          gaps); single column otherwise, and always single-column in print so
          the printed passport keeps its stacked layout. break-inside-avoid on
          each card keeps a card whole across a column/page break. */}
      <div className="columns-1 gap-4 xl:columns-2 print:columns-1 [&>*]:mb-4 [&>*]:break-inside-avoid">
        {/* Identity */}
        <section className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none">
          <div className="flex items-center gap-4">
            <Avatar profile={profile} size="md" />
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold text-slate-900 dark:text-slate-100">
                {identity.name}
              </h1>
              <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
                {inScope(fields, "identity") && (
                  <>
                    <Fact
                      label="Age"
                      value={
                        identity.age != null ? (
                          identity.age
                        ) : (
                          <span className="text-base font-normal text-slate-400">
                            {mode === "app" && !identity.hasBirthdate
                              ? "Add birthdate in Settings"
                              : "Unknown"}
                          </span>
                        )
                      }
                    />
                    {identity.birthdate && (
                      <Fact
                        label="Birthdate"
                        value={fmtDate(identity.birthdate)}
                      />
                    )}
                    <Fact
                      label="Sex"
                      value={
                        identity.sex ? (
                          <span className="capitalize">{identity.sex}</span>
                        ) : (
                          <span className="text-base font-normal text-slate-400">
                            Unknown
                          </span>
                        )
                      }
                    />
                  </>
                )}
                {inScope(fields, "blood_type") && (
                  <Fact
                    label="Blood type"
                    value={
                      identity.bloodType ?? (
                        <span className="text-base font-normal text-slate-400">
                          Unknown
                        </span>
                      )
                    }
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Allergies — an emergency-card essential, shown prominently. Merges
          documented allergies with lab-derived IgE sensitizations. */}
        {inScope(fields, "allergies") && (
          <Section title="Allergies">
            {summary.allergies.length > 0 ? (
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {summary.allergies.map((a, i) => (
                  <li
                    key={`${a.substance}-${i}`}
                    className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                  >
                    <span className="min-w-0 text-slate-800 dark:text-slate-200">
                      {a.substance}
                      {(a.reaction || a.severity) && (
                        <span className="text-slate-500 dark:text-slate-400">
                          {" "}
                          —{" "}
                          {[a.severity, a.reaction].filter(Boolean).join(", ")}
                        </span>
                      )}
                    </span>
                    {(a.origin !== "documented" || a.evidence) && (
                      <span className="flex shrink-0 items-baseline gap-1.5">
                        {a.origin !== "documented" && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            {a.origin === "both" ? "labs confirm" : "from labs"}
                          </span>
                        )}
                        {a.evidence && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {a.evidence}
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No known allergies recorded.</Empty>
            )}
            {summary.crossReactivity.length > 0 && (
              <div
                className="mt-3 border-t border-black/5 pt-3 dark:border-white/5"
                data-testid="cross-reactivity"
              >
                <div className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Cross-reactivity (informational)
                </div>
                <ul className="space-y-1.5">
                  {summary.crossReactivity.map((c) => (
                    <li
                      key={c.familyId}
                      className="text-xs text-slate-600 dark:text-slate-300"
                      data-testid="cross-reactivity-item"
                    >
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        {c.triggers.join(", ")}
                      </span>{" "}
                      commonly cross-reacts with {c.related.join(", ")}.{" "}
                      <span className="text-slate-500 dark:text-slate-400">
                        ({c.label})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        )}

        {/* Conditions / problem list — a passport essential. */}
        {inScope(fields, "conditions") && (
          <Section title="Conditions / problems">
            {summary.conditions.length > 0 ? (
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {summary.conditions.map((c, i) => (
                  <li
                    key={`${c.name}-${i}`}
                    className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                  >
                    <span className="min-w-0 text-slate-800 dark:text-slate-200">
                      {c.name}
                      {c.code && (
                        <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                          {c.code}
                        </span>
                      )}
                    </span>
                    {c.onsetDate && (
                      <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                        since {fmtDate(c.onsetDate)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No active conditions recorded.</Empty>
            )}
          </Section>
        )}

        {/* Family history — hereditary-risk context, shown alongside the problem
          list. Gated under its OWN "family_history" share field (NOT "conditions"):
          relatives' diagnoses / onset ages / deceased status are genetically-
          sensitive third-party PHI, so a conditions-only link must never expose them.
          Only rendered when there are entries so it never adds an empty card. */}
        {inScope(fields, "family_history") &&
          summary.familyHistory.length > 0 && (
            <Section title="Family history">
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {summary.familyHistory.map((f, i) => (
                  <li
                    key={`${f.relation}-${f.condition}-${i}`}
                    className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                  >
                    <span className="min-w-0 text-slate-800 dark:text-slate-200">
                      {f.condition}
                      {f.relation && (
                        <span className="text-slate-500 dark:text-slate-400">
                          {" "}
                          — {f.relation}
                        </span>
                      )}
                      {f.deceased && (
                        <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                          (deceased)
                        </span>
                      )}
                    </span>
                    {f.onsetAge != null && (
                      <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                        onset age {f.onsetAge}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

        {/* Body */}
        {showBody && (
          <Section title="Body">
            {hasBody ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <Fact
                  label="Height"
                  value={
                    body.heightCm != null
                      ? `${Math.round(body.heightCm)} cm`
                      : "—"
                  }
                  sub={body.heightDate ? fmtDate(body.heightDate) : undefined}
                />
                <Fact
                  label="Weight"
                  value={
                    body.weightKg != null
                      ? fmtWeight(body.weightKg, weightUnit)
                      : "—"
                  }
                  sub={body.weightDate ? fmtDate(body.weightDate) : undefined}
                />
                <Fact label="BMI" value={body.bmi != null ? body.bmi : "—"} />
                <Fact
                  label="Body fat"
                  value={body.bodyFatPct != null ? `${body.bodyFatPct}%` : "—"}
                  sub={body.bodyFatDate ? fmtDate(body.bodyFatDate) : undefined}
                />
                <Fact
                  label="Resting HR"
                  value={
                    body.restingHr != null
                      ? `${Math.round(body.restingHr)} bpm`
                      : "—"
                  }
                  sub={
                    body.restingHrDate ? fmtDate(body.restingHrDate) : undefined
                  }
                />
              </div>
            ) : (
              <Empty>No body metrics recorded.</Empty>
            )}

            {/* Pediatric growth percentiles, shown only for a child in
              chart range. "Reference — not medical advice" per the disclaimer. */}
            {body.growth && (
              <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/10">
                <div className="mb-2 flex flex-wrap gap-2">
                  {body.growth.heightPercentile != null && (
                    <GrowthBadge
                      label="Height"
                      percentile={body.growth.heightPercentile}
                    />
                  )}
                  {body.growth.weightPercentile != null && (
                    <GrowthBadge
                      label="Weight"
                      percentile={body.growth.weightPercentile}
                    />
                  )}
                  {body.growth.bmiPercentile != null && (
                    <GrowthBadge
                      label="BMI"
                      percentile={body.growth.bmiPercentile}
                    />
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Growth percentile for age &amp; sex (WHO/CDC) — not medical
                  advice.
                </p>
              </div>
            )}
          </Section>
        )}

        {/* Vitals & biomarkers */}
        {inScope(fields, "vitals") && (
          <Section title="Current vitals & biomarkers">
            {summary.vitals.length > 0 ? (
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {summary.vitals.map((v, i) => (
                  <li
                    key={`${v.name}-${i}`}
                    className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                  >
                    <span className="min-w-0 text-slate-800 dark:text-slate-200">
                      {v.starred ? "★ " : ""}
                      {v.name}
                    </span>
                    <span className="shrink-0 text-right">
                      <MedicalValue
                        value={v.value}
                        unit={v.unit}
                        flag={v.flag}
                      />
                      {v.date && (
                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                          {fmtDate(v.date)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No flagged or starred biomarkers.</Empty>
            )}
          </Section>
        )}

        {/* Medications & supplements — each flows as its own card in the column
          layout (no nested 2-col grid, which would cramp inside a half-width
          column). */}
        {(inScope(fields, "medications") || inScope(fields, "supplements")) && (
          <>
            {inScope(fields, "medications") && (
              <Section title="Medications">
                {summary.medications.length > 0 ? (
                  <ul className="divide-y divide-black/5 dark:divide-white/5">
                    {summary.medications.map((m, i) => (
                      <li
                        key={`${m.name}-${i}`}
                        className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                      >
                        <span className="min-w-0 text-slate-800 dark:text-slate-200">
                          {m.name}
                          {m.detail && (
                            <span className="text-slate-500 dark:text-slate-400">
                              {" "}
                              — {m.detail}
                            </span>
                          )}
                        </span>
                        {m.date && (
                          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                            since {fmtDate(m.date)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No active medications.</Empty>
                )}
              </Section>
            )}
            {inScope(fields, "supplements") && (
              <Section title="Supplements">
                {summary.supplements.length > 0 ? (
                  <ul className="divide-y divide-black/5 dark:divide-white/5">
                    {summary.supplements.map((s, i) => (
                      <li
                        key={`${s.name}-${i}`}
                        className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                      >
                        <span className="min-w-0 text-slate-800 dark:text-slate-200">
                          {s.name}
                          {s.detail && (
                            <span className="text-slate-500 dark:text-slate-400">
                              {" "}
                              — {s.detail}
                            </span>
                          )}
                        </span>
                        {s.date && (
                          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                            since {fmtDate(s.date)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No active supplements.</Empty>
                )}
              </Section>
            )}
          </>
        )}

        {/* Immunizations */}
        {inScope(fields, "immunizations") && (
          <Section title="Immunizations">
            {summary.immunizations.length > 0 || summary.titers.length > 0 ? (
              <div className="flex flex-col gap-3">
                {summary.immunizations.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {summary.immunizations.map((v) => {
                          const badge = statusBadgeParts(v.status, v.isImmune);
                          return (
                            <tr
                              key={v.code}
                              className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
                            >
                              <td className="py-1.5 pr-3 text-slate-800 dark:text-slate-200">
                                {v.name}
                              </td>
                              <td className="py-1.5 pr-3">
                                <span className={`badge ${badge.cls}`}>
                                  {badge.text}
                                </span>
                              </td>
                              <td className="py-1.5 text-right text-xs text-slate-500 dark:text-slate-400">
                                {v.doses.length > 0 ? (
                                  <div className="flex flex-col gap-0.5">
                                    {v.doses.map((d, di) => (
                                      <span
                                        key={di}
                                        className="whitespace-nowrap"
                                      >
                                        {d.label ? `${d.label}: ` : ""}
                                        {fmtDate(d.date)}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {summary.titers.length > 0 && (
                  <div>
                    <div className="mb-1 section-label">Immunity titers</div>
                    <ul className="divide-y divide-black/5 dark:divide-white/5">
                      {summary.titers.map((t, i) => (
                        <li
                          key={`${t.marker}-${i}`}
                          className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                        >
                          <span className="min-w-0 text-slate-800 dark:text-slate-200">
                            {t.marker}
                          </span>
                          <span className="shrink-0 text-xs capitalize text-slate-500 dark:text-slate-400">
                            {t.status.replace("_", "-")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <Empty>No immunizations tracked.</Empty>
            )}
          </Section>
        )}

        {/* Recent medical history */}
        {inScope(fields, "history") && (
          <Section title="Recent medical history">
            {summary.history.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {summary.history.map((h, i) => (
                      <tr
                        key={`${h.name}-${i}`}
                        className="border-b border-black/5 last:border-0 dark:border-white/5"
                      >
                        <td className="py-1.5 pr-3 text-slate-800 dark:text-slate-200">
                          {h.name}
                        </td>
                        <td className="py-1.5 pr-3 text-right">
                          <MedicalValue
                            value={h.value}
                            unit={h.unit}
                            flag={h.flag}
                          />
                        </td>
                        <td className="py-1.5 text-right text-xs text-slate-500 dark:text-slate-400">
                          {fmtDate(h.date)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No medical history recorded.</Empty>
            )}
          </Section>
        )}
      </div>

      {/* Footer: generated date + disclaimer (screen + print). */}
      <footer className="px-1 pb-4 text-xs text-slate-500 dark:text-slate-400">
        Generated {fmtDate(generatedAt)}. This summary is for informational
        purposes only and is not medical advice or a complete medical record.
      </footer>
    </div>
  );
}
