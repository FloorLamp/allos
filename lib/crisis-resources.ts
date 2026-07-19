// Crisis-resource configuration + formatting (issue #996). PURE — no DB/network,
// client-safe, unit-tested in lib/__tests__/crisis-resources.test.ts.
//
// The app surfaces a crisis resource; it NEVER intervenes, contacts anyone, or
// egresses the signal. The resource LIST is operator-configured (Settings → Server,
// admin) with an optional per-profile override (Settings → Profile) — this module
// holds the pure shape, parsing, resolution, and formatting. There is DELIBERATELY
// no hardcoded `988` or any country default: 988 is US-only and wrong for a
// self-hosted, international audience. When nothing is configured we show a neutral
// fallback ("contact your local emergency services / a local crisis line") plus an
// admin-visible pointer to configure — never a fabricated number.
//
// The copy register follows the issues' decided framing (the #716/#1001 precedent):
// supportive and "you're not alone", non-alarmist, never a diagnosis — the one
// deliberate place the app's "calm by default" ethos yields toward visibility.

// One operator-configured crisis resource: a human label and a free-text contact
// (a phone number, an SMS line, a URL — whatever the operator's region needs).
export interface CrisisResource {
  label: string;
  contact: string;
}

// The neutral, region-agnostic fallback shown when NO resource is configured. Never
// a real/fake number — just the universally-true guidance to reach local services.
export const CRISIS_FALLBACK_LINE =
  "If you’re in immediate danger, contact your local emergency services or a local crisis line.";

// The lead-in used across the passive surface + the reactive inline finding — the
// supportive, non-alarmist register (#716/#1001). No diagnosis, no alarm.
export const CRISIS_LEAD_LINE =
  "If you’re in crisis or thinking about harming yourself, you’re not alone.";

const MAX_RESOURCES = 12;
const MAX_LABEL = 120;
const MAX_CONTACT = 200;

function clean(s: unknown, cap: number): string {
  return typeof s === "string" ? s.trim().slice(0, cap) : "";
}

// Normalize a list of candidate rows (from a form or stored JSON): trim, cap
// lengths, drop rows with no contact (a bare label is useless), cap the count. A
// row may omit its label (the contact alone is shown).
export function normalizeCrisisResources(
  rows: readonly { label?: unknown; contact?: unknown }[]
): CrisisResource[] {
  const out: CrisisResource[] = [];
  for (const r of rows) {
    const contact = clean(r?.contact, MAX_CONTACT);
    if (!contact) continue;
    out.push({ label: clean(r?.label, MAX_LABEL), contact });
    if (out.length >= MAX_RESOURCES) break;
  }
  return out;
}

// Parse a stored JSON array back to resources; tolerant of any malformed value
// (returns []), so a hand-edited DB can never throw on a read path.
export function parseCrisisResources(
  raw: string | null | undefined
): CrisisResource[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? normalizeCrisisResources(v) : [];
  } catch {
    return [];
  }
}

export function serializeCrisisResources(list: CrisisResource[]): string {
  return JSON.stringify(normalizeCrisisResources(list));
}

// The textarea representation the config UIs use: one resource per line, as
// "Label | contact" (or just "contact"). Editing free text is the least-friction,
// self-hoster-friendly form for a region-specific list.
export function formatCrisisResourcesText(list: CrisisResource[]): string {
  return list
    .map((r) => (r.label ? `${r.label} | ${r.contact}` : r.contact))
    .join("\n");
}

// Parse the textarea back to resources: each non-blank line splits on the FIRST
// "|" into label + contact (a line with no "|" is a bare contact). Normalized/
// capped like any other input.
export function parseCrisisResourcesText(text: string): CrisisResource[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("|");
      return i === -1
        ? { label: "", contact: line }
        : { label: line.slice(0, i), contact: line.slice(i + 1) };
    });
  return normalizeCrisisResources(rows);
}

// Which resources apply for a profile: a non-empty per-profile override wins,
// otherwise the global instance default (which may itself be empty → the neutral
// fallback surfaces). The override is private to the profile — the caller resolves
// it from THIS profile's settings only; nothing crosses profiles.
export function resolveCrisisResources(
  global: CrisisResource[],
  override: CrisisResource[] | null
): CrisisResource[] {
  return override && override.length > 0 ? override : global;
}

// Whether a configured list exists (vs. the neutral fallback state). Drives the
// admin-visible "configure resources" pointer.
export function hasConfiguredCrisisResources(
  resources: CrisisResource[]
): boolean {
  return resources.length > 0;
}

// One resource rendered as a compact inline string ("Label: contact" / "contact").
export function crisisResourceText(r: CrisisResource): string {
  return r.label ? `${r.label}: ${r.contact}` : r.contact;
}

// The single calm line the REACTIVE inline finding carries (replacing the old
// hardcoded-988 constant, #996): the supportive lead, the configured resources (or
// the neutral fallback when none), and a gentle discuss-with-a-clinician note. One
// pure formatter both the crisis finding and any other inline surface share.
export function crisisFindingLine(resources: CrisisResource[]): string {
  const body = resources.length
    ? `Reach out — ${resources.map(crisisResourceText).join("; ")}.`
    : CRISIS_FALLBACK_LINE;
  return `${CRISIS_LEAD_LINE} ${body} Consider discussing these results with a clinician.`;
}
