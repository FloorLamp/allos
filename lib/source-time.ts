import { isRealIsoDate, utcInstant } from "./date";

// THE INGEST BOUNDARY FOR TIME (issue #2243, #2205 phase 0).
//
// ── THE QUESTION THIS ANSWERS ────────────────────────────────────────────────
//
// "What did the source actually say about WHEN?" — asked once, at the door, before
// any destination column is chosen.
//
// Until this module existed, the clinical-document parsers answered a different
// question: they returned the DAY, three layers before anyone knew what the value
// was for. `hl7Date` truncated an HL7 v3 TS at its eighth character and `isoDate`
// did `v.slice(0, 10)`, so a C-CDA `effectiveTime` of `20260807143000-0500` and a
// FHIR `2026-08-07` arrived indistinguishable. The information was not narrowed at a
// destination that wanted a day; it was destroyed at the parser, and the moment a
// destination widened (medical_records.occurred_at, migration 165) the parser
// silently failed to fill it while the nullable column looked adopted.
//
// The rule, stated once: PRESERVE AT THE SOURCE'S OWN GRAIN; NARROW AT THE
// DESTINATION, per the grain that destination declares (lib/time-columns.ts).
//
// ── WHY THREE ARMS AND NOT `string | null` ──────────────────────────────────
//
// The source genuinely has three cases, and the third is the one a nullable string
// can never express:
//
//   day      the source stated a calendar day and nothing more.
//   instant  a time AND an offset — a real absolute moment.
//   local    a time with NO offset. Both HL7 v3 TS and FHIR `dateTime` permit this,
//            and it is a wall clock that CANNOT become an instant without a zone
//            nobody supplied.
//
// Collapsing `local` into `instant` by reaching for the profile's timezone is exactly
// the invention this boundary exists to prevent: the facility's zone is not the
// patient's, and "usually the same country" is how correct-looking code produces a
// confidently wrong answer. `local` therefore leaves an instant destination NULL
// (`sourceInstant` below). The DAY is still known, so nothing is lost that was ever
// stated. Facility-zone inference is a separate decision needing its own evidence and
// is deliberately not made here.
//
// ── THE DAY AND THE INSTANT DISAGREE, AND BOTH ARE RIGHT ────────────────────
//
// `date` is the source's OWN STATED calendar day — the digits it wrote — and is never
// re-derived from the instant. `20260101003000+0900` states 2026-01-01 and is
// 2025-12-31T15:30:00Z; a day-grained destination (#94 day attribution: a condition's
// onset, an immunization's date, a reading's `date`) takes the FORMER, always. Shifting
// it by the offset would change a day attribution, which #2205 constraint 4 puts out of
// scope by definition. `lib/__tests__/source-time.test.ts` pins this; it is the test
// that fails if a later contributor "unifies" the two by deriving one from the other.
//
// PURE — no DB, no clock, no network. `utcInstant` is lib/date.ts's canonical
// serialization (UTC, second resolution, explicit `Z`), so an instant produced here is
// byte-identical to one any other app write path produces.

export type SourceTime =
  // The source stated a day and nothing more.
  | { grain: "day"; date: string }
  // A time AND an offset: a real instant. `instant` is UTC+Z (lib/date.ts's
  // convention); `date` is the source's own stated local day, NOT the UTC day.
  | { grain: "instant"; date: string; instant: string }
  // A time with NO offset — permitted by both HL7 TS and FHIR dateTime. A local
  // wall clock that cannot become an instant without a zone nobody supplied.
  | { grain: "local"; date: string; hhmm: string };

// The parsed pieces both grammars reduce to, before either becomes a SourceTime.
interface Parts {
  date: string; // the source's stated calendar day, validated
  hh: number | null; // null when the source stated no time at all
  mm: number;
  ss: number;
  offsetMinutes: number | null; // null when the source stated no offset
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Assemble the arm from validated parts. The ONE place the three-way choice is made,
// so HL7 and FHIR cannot drift on it.
function fromParts(p: Parts): SourceTime {
  if (p.hh == null) return { grain: "day", date: p.date };
  const hhmm = `${pad2(p.hh)}:${pad2(p.mm)}`;
  if (p.offsetMinutes == null) return { grain: "local", date: p.date, hhmm };
  const [y, mo, d] = p.date.split("-").map(Number);
  const ms =
    Date.UTC(y, mo - 1, d, p.hh, p.mm, p.ss) - p.offsetMinutes * 60_000;
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return { grain: "local", date: p.date, hhmm };
  return { grain: "instant", date: p.date, instant: utcInstant(at) };
}

// A stated clock time is kept only when every component is in range. An out-of-range
// one degrades to the DAY the source also stated rather than being repaired into a
// different moment — never guess a time.
function timeOrNone(
  hh: string | undefined,
  mm: string | undefined,
  ss: string | undefined
): { hh: number | null; mm: number; ss: number } {
  if (hh == null) return { hh: null, mm: 0, ss: 0 };
  const h = Number(hh);
  const m = mm == null ? 0 : Number(mm);
  // A stated leap second (:60) is real in both grammars; clamp it into the minute
  // rather than dropping the whole time.
  const s = ss == null ? 0 : Math.min(Number(ss), 59);
  if (h > 23 || m > 59) return { hh: null, mm: 0, ss: 0 };
  return { hh: h, mm: m, ss: s };
}

// `+ZZZZ` / `-ZZZZ` / `Z` → minutes east of UTC. Null when absent or out of range —
// an unusable offset makes the value LOCAL (a clock with no zone), never UTC.
function offsetMinutes(
  sign: string | undefined,
  hh: string | undefined,
  mm: string | undefined
): number | null {
  if (sign == null) return null;
  if (sign === "Z" || sign === "z") return 0;
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h > 23 || m > 59) return null;
  return (sign === "-" ? -1 : 1) * (h * 60 + m);
}

// HL7 v3 TS: YYYYMMDD[HH[MM[SS[.SSSS]]]][±ZZZZ]. Anything shorter than a full day
// (a bare `2026` / `202608` partial) has no calendar day and is dropped, matching the
// behaviour every C-CDA call site has always had.
const HL7_TS =
  /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.\d+)?)?)?)?\s*(?:([+-])(\d{2})(\d{2})|(Z|z))?/;

// A C-CDA `effectiveTime`/`time`/`birthTime` @value → what the document actually said.
export function hl7SourceTime(v: unknown): SourceTime | null {
  if (v == null) return null;
  const m = HL7_TS.exec(String(v).trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isRealIsoDate(date)) return null;
  const t = timeOrNone(m[4], m[5], m[6]);
  return fromParts({
    date,
    ...t,
    offsetMinutes: offsetMinutes(m[7] ?? m[10], m[8], m[9]),
  });
}

// FHIR `date` / `dateTime` / `instant`: YYYY-MM-DD[Thh:mm[:ss[.sss]][Z|±hh:mm]].
// A FHIR partial (`2021`, `2021-01`) carries no calendar day and is dropped, matching
// the behaviour every call site has always had.
const FHIR_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:([+-])(\d{2}):(\d{2})|(Z|z))?)?/;

export function fhirSourceTime(v: unknown): SourceTime | null {
  if (typeof v !== "string") return null;
  const m = FHIR_DATETIME.exec(v.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isRealIsoDate(date)) return null;
  const t = timeOrNone(m[4], m[5], m[6]);
  return fromParts({
    date,
    ...t,
    offsetMinutes: offsetMinutes(m[7] ?? m[10], m[8], m[9]),
  });
}

// ── The two destination readers ─────────────────────────────────────────────
//
// A day-grained destination reads `sourceDay` and NOTHING else — never the offset,
// never a UTC re-derivation off the instant.
export function sourceDay(t: SourceTime | null | undefined): string | null {
  return t ? t.date : null;
}

// An instant-grained destination reads `sourceInstant`, which is null unless the
// source stated BOTH a time and an offset. A `local` source leaves the column NULL by
// decision: a zoneless clinical timestamp is not resolvable against the profile's
// timezone without inventing a fact.
export function sourceInstant(t: SourceTime | null | undefined): string | null {
  return t && t.grain === "instant" ? t.instant : null;
}
