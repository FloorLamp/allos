import type { Sex } from "./types";
import type { EmergencyEpisodeSection } from "./illness-episode-format";

// Pure assembly + (de)serialization for the offline Emergency Card (issue #42).
// The card is a deliberately terse, printable snapshot of the facts a stranger or
// first responder needs when the person can't speak for themselves: allergies,
// active medications, major conditions, blood type, and an emergency contact.
//
// Everything here is DB- and DOM-free so it can be unit-tested directly (see
// lib/__tests__/emergency-card.test.ts). The server gathering lives in
// lib/emergency-card-load.ts; the localStorage read/write wrapper (the offline
// copy) lives in components/emergency-offline.ts and leans on the pure
// (de)serializers below so the stored shape stays validated in one place.

export interface EmergencyCardAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
}

export interface EmergencyCardMedication {
  name: string;
  // Dose / schedule detail when known ("50 mg · Morning"), else null.
  detail: string | null;
}

export interface EmergencyCardCondition {
  name: string;
  onsetDate: string | null;
}

export interface EmergencyContact {
  name: string;
  phone: string | null;
  relation: string | null;
}

export interface EmergencyCard {
  name: string;
  age: number | null;
  sex: Sex | null;
  birthdate: string | null; // YYYY-MM-DD, when known
  bloodType: string | null; // "O+", "AB-", … or null when unknown
  allergies: EmergencyCardAllergy[];
  medications: EmergencyCardMedication[];
  conditions: EmergencyCardCondition[];
  contact: EmergencyContact | null;
  // The active-illness-episode section (issue #859 item 6) — present ONLY while an
  // episode is open (the ER "what have they taken today?" answer), else null. A
  // formatter over the ONE assembly (emergencyEpisodeSection), so it can't disagree
  // with the episode page.
  activeEpisode?: EmergencyEpisodeSection | null;
  // ISO timestamp the snapshot was assembled — drives the "as of" staleness note
  // so a reader knows how fresh the offline copy is.
  generatedAt: string;
}

export interface EmergencyCardInput {
  name: string;
  age: number | null;
  sex: Sex | null;
  birthdate: string | null;
  // A manually-entered blood type (profile setting) always wins over one derived
  // from lab records — the person knows their own type even without a lab on file.
  manualBloodType: string | null;
  derivedBloodType: string | null;
  allergies: readonly EmergencyCardAllergy[];
  medications: readonly EmergencyCardMedication[];
  conditions: readonly EmergencyCardCondition[];
  contact: {
    name: string | null;
    phone: string | null;
    relation: string | null;
  } | null;
  // The active-episode section, when an episode is open, else null (issue #859 item 6).
  activeEpisode?: EmergencyEpisodeSection | null;
  generatedAt: string;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

// Order allergies most-dangerous-first so a reader in a hurry sees the
// life-threatening ones at the top. Severity is free text (the allergies form is
// an open input), so match on the words that actually appear; unknown severities
// sort last but stay visible. Lower rank sorts earlier.
export function allergySeverityRank(severity: string | null): number {
  const s = (severity ?? "").toLowerCase();
  if (!s) return 3;
  if (/anaphyla|life|severe|critical/.test(s)) return 0;
  if (/moderate/.test(s)) return 1;
  if (/mild|minor/.test(s)) return 2;
  return 3;
}

// Assemble the card view-model from the individual gathered inputs. Blanks are
// dropped, allergies are severity-ordered, and the contact collapses to null
// unless at least a name or phone is present.
export function buildEmergencyCard(input: EmergencyCardInput): EmergencyCard {
  const allergies = input.allergies
    .map((a) => ({
      substance: (a.substance ?? "").trim(),
      reaction: clean(a.reaction),
      severity: clean(a.severity),
    }))
    .filter((a) => a.substance !== "")
    .sort((a, b) => {
      const r =
        allergySeverityRank(a.severity) - allergySeverityRank(b.severity);
      if (r !== 0) return r;
      return a.substance.localeCompare(b.substance, undefined, {
        sensitivity: "base",
      });
    });

  const medications = input.medications
    .map((m) => ({ name: (m.name ?? "").trim(), detail: clean(m.detail) }))
    .filter((m) => m.name !== "");

  const conditions = input.conditions
    .map((c) => ({
      name: (c.name ?? "").trim(),
      onsetDate: clean(c.onsetDate),
    }))
    .filter((c) => c.name !== "");

  const contactName = clean(input.contact?.name);
  const contactPhone = clean(input.contact?.phone);
  const contact: EmergencyContact | null =
    contactName || contactPhone
      ? {
          name: contactName ?? "",
          phone: contactPhone,
          relation: clean(input.contact?.relation),
        }
      : null;

  return {
    name: input.name,
    age: input.age,
    sex: input.sex,
    birthdate: clean(input.birthdate),
    bloodType: clean(input.manualBloodType) ?? clean(input.derivedBloodType),
    allergies,
    medications,
    conditions,
    contact,
    activeEpisode: input.activeEpisode ?? null,
    generatedAt: input.generatedAt,
  };
}

// True when the card carries no clinically useful content beyond the person's
// identity — the /emergency page shows a gentle "nothing recorded yet" note
// rather than an empty scaffold in that case.
export function isEmergencyCardEmpty(card: EmergencyCard): boolean {
  return (
    card.allergies.length === 0 &&
    card.medications.length === 0 &&
    card.conditions.length === 0 &&
    !card.bloodType &&
    !card.contact &&
    !card.activeEpisode
  );
}

// ---- Blood type (manual per-profile setting) ----

// The blood types the manual setting accepts. ABO group with an optional Rh sign;
// "unknown" isn't stored (the field is simply cleared).
export const BLOOD_TYPES = [
  "O+",
  "O-",
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
] as const;

export type BloodType = (typeof BLOOD_TYPES)[number];

// Normalize a user-entered blood type to a canonical member, or null. Tolerant of
// case/spacing and "pos"/"neg" spellings so "ab positive" → "AB+".
export function normalizeBloodType(
  value: string | null | undefined
): BloodType | null {
  if (!value) return null;
  let v = value.toUpperCase().replace(/\s+/g, "");
  v = v.replace(/POS(ITIVE)?$/, "+").replace(/NEG(ATIVE)?$/, "-");
  return (BLOOD_TYPES as readonly string[]).includes(v)
    ? (v as BloodType)
    : null;
}

// ---- Offline payload (localStorage) ----
// The offline copy is the card wrapped with the owning profile id and a schema
// version, so a format change or a stale other-profile blob is ignored on read
// rather than mis-rendered. The wrapper is the single validated shape both the
// writer (components/emergency-offline.ts) and the /offline reader parse.

export const EMERGENCY_PAYLOAD_VERSION = 1;

export interface EmergencyPayload {
  version: number;
  profileId: number;
  card: EmergencyCard;
}

export function serializeEmergencyPayload(
  profileId: number,
  card: EmergencyCard
): string {
  const payload: EmergencyPayload = {
    version: EMERGENCY_PAYLOAD_VERSION,
    profileId,
    card,
  };
  return JSON.stringify(payload);
}

// Parse a stored payload defensively: any malformed / wrong-version / wrong-shape
// blob yields null (so the offline surface simply shows "no card cached") rather
// than throwing. Returns the profile id alongside the card so a caller with a
// session can reject a blob left by a different profile.
export function parseEmergencyPayload(
  raw: string | null | undefined
): EmergencyPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.version !== EMERGENCY_PAYLOAD_VERSION) return null;
  if (typeof p.profileId !== "number") return null;
  const card = p.card as Record<string, unknown> | undefined;
  if (!card || typeof card !== "object") return null;
  if (typeof card.name !== "string" || typeof card.generatedAt !== "string") {
    return null;
  }
  if (
    !Array.isArray(card.allergies) ||
    !Array.isArray(card.medications) ||
    !Array.isArray(card.conditions)
  ) {
    return null;
  }
  return {
    version: p.version,
    profileId: p.profileId,
    card: card as unknown as EmergencyCard,
  };
}
