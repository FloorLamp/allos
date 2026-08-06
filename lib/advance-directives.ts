// Pure model for the profile's ADVANCE-DIRECTIVE SUMMARY (issue #1848): code
// status, healthcare proxy, organ-donor status, and where the signed documents
// physically live. These are the first facts an ED asks for when the patient
// can't speak — and until now the emergency card, whose whole purpose is exactly
// that moment, could not hold any of them.
//
// This is deliberately a SUMMARY, not document storage: the POLST/living will
// itself is an uploaded medical document. What lives here is the at-a-glance
// answer plus a pointer to where the paper is.
//
// DB- and DOM-free (unit-tested in lib/__tests__/advance-directives.test.ts).
// Storage is the `profile_settings` tier — these are data-subject health facts,
// which is precisely what that tier is for, so no schema change is involved
// (accessors: getAdvanceDirectives / setAdvanceDirectives in
// lib/settings/profile-attrs.ts). Rendered by the emergency card (screen, print
// and the offline copy) and by the passport.

// The code-status vocabulary. Small and closed on purpose: a first responder
// reads one of these five phrases, not a paragraph. Anything a five-way enum
// cannot express (a POLST's per-intervention detail, a time-limited trial) goes
// in the free-text QUALIFIER line beside it rather than growing the enum — the
// qualifier is what keeps a coarse enum honest.
export const CODE_STATUSES = [
  {
    key: "full",
    label: "Full code",
    detail: "Attempt CPR and full treatment",
  },
  {
    key: "dnr",
    label: "DNR",
    detail: "Do not attempt resuscitation (no CPR)",
  },
  {
    key: "dnr-dni",
    label: "DNR / DNI",
    detail: "No CPR and no intubation",
  },
  {
    key: "limited",
    label: "Limited / selective treatment",
    detail: "Treat, but no intensive care escalation",
  },
  {
    key: "comfort",
    label: "Comfort-focused care only",
    detail: "Comfort measures; no life-prolonging treatment",
  },
] as const;

export type CodeStatus = (typeof CODE_STATUSES)[number]["key"];

const CODE_STATUS_KEYS: ReadonlySet<string> = new Set(
  CODE_STATUSES.map((c) => c.key)
);

// Organ-donor status. "Not recorded" is the ABSENCE of a value, never a third
// enum member: an unanswered question and a declared "no" are different claims,
// and a card that prints one as the other is worse than a card that prints
// neither.
export const ORGAN_DONOR_STATUSES = [
  { key: "registered", label: "Registered organ donor" },
  { key: "declined", label: "Not an organ donor" },
] as const;

export type OrganDonorStatus = (typeof ORGAN_DONOR_STATUSES)[number]["key"];

const ORGAN_DONOR_KEYS: ReadonlySet<string> = new Set(
  ORGAN_DONOR_STATUSES.map((o) => o.key)
);

// The person authorized to speak for the patient. All three parts optional; the
// proxy collapses to null unless at least a name or a phone is present (the same
// rule the emergency CONTACT already uses — a bare relationship names nobody).
export interface HealthcareProxy {
  name: string;
  relation: string | null;
  phone: string | null;
}

export interface AdvanceDirectives {
  codeStatus: CodeStatus | null;
  // YYYY-MM-DD the code status took effect (when the form was signed), or null.
  codeStatusEffective: string | null;
  // Free-text qualifier for a code status the enum is too coarse for
  // ("DNR, but intubate for a reversible cause"). Rendered through <NotesText>.
  codeStatusNote: string | null;
  proxy: HealthcareProxy | null;
  organDonor: OrganDonorStatus | null;
  // Where the signed paperwork physically is ("POLST on the fridge; copy with
  // Dr. Reed"). Free text, rendered through <NotesText>.
  documentsAt: string | null;
}

export interface AdvanceDirectivesInput {
  codeStatus: string | null | undefined;
  codeStatusEffective: string | null | undefined;
  codeStatusNote: string | null | undefined;
  proxyName: string | null | undefined;
  proxyRelation: string | null | undefined;
  proxyPhone: string | null | undefined;
  organDonor: string | null | undefined;
  documentsAt: string | null | undefined;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

export function normalizeCodeStatus(
  value: string | null | undefined
): CodeStatus | null {
  const v = (value ?? "").trim().toLowerCase();
  return CODE_STATUS_KEYS.has(v) ? (v as CodeStatus) : null;
}

export function normalizeOrganDonor(
  value: string | null | undefined
): OrganDonorStatus | null {
  const v = (value ?? "").trim().toLowerCase();
  return ORGAN_DONOR_KEYS.has(v) ? (v as OrganDonorStatus) : null;
}

export function codeStatusLabel(status: CodeStatus): string {
  return CODE_STATUSES.find((c) => c.key === status)?.label ?? status;
}

export function codeStatusDetail(status: CodeStatus): string | null {
  return CODE_STATUSES.find((c) => c.key === status)?.detail ?? null;
}

export function organDonorLabel(status: OrganDonorStatus): string {
  return ORGAN_DONOR_STATUSES.find((o) => o.key === status)?.label ?? status;
}

// Assemble the directive summary from stored/submitted strings. Unrecognized enum
// values normalize to null (an unreadable stored value must never print as a code
// status), and an effective date without a code status is dropped: a date alone
// asserts nothing and would render as a dangling "as of".
export function buildAdvanceDirectives(
  input: AdvanceDirectivesInput
): AdvanceDirectives {
  const codeStatus = normalizeCodeStatus(input.codeStatus);
  const proxyName = clean(input.proxyName);
  const proxyPhone = clean(input.proxyPhone);
  return {
    codeStatus,
    codeStatusEffective: codeStatus ? clean(input.codeStatusEffective) : null,
    codeStatusNote: clean(input.codeStatusNote),
    proxy:
      proxyName || proxyPhone
        ? {
            name: proxyName ?? "",
            relation: clean(input.proxyRelation),
            phone: proxyPhone,
          }
        : null,
    organDonor: normalizeOrganDonor(input.organDonor),
    documentsAt: clean(input.documentsAt),
  };
}

// True when nothing was recorded — the card and passport render the section only
// when this is false, so an untouched profile sees no empty scaffold.
export function hasAdvanceDirectives(d: AdvanceDirectives | null): boolean {
  if (!d) return false;
  return (
    d.codeStatus != null ||
    d.codeStatusNote != null ||
    d.proxy != null ||
    d.organDonor != null ||
    d.documentsAt != null
  );
}

export const EMPTY_ADVANCE_DIRECTIVES: AdvanceDirectives = {
  codeStatus: null,
  codeStatusEffective: null,
  codeStatusNote: null,
  proxy: null,
  organDonor: null,
  documentsAt: null,
};
