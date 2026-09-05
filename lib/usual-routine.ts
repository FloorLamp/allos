// THE MORNING IS ONE PHYSICAL EVENT (issue #2458). Pure, DB-free, clock-free.
//
// On one profile's ledger the morning is a smoothie: two food groups logged 21/21
// days and three Morning-declared supplement doses confirmed most days IN THE SAME
// MINUTE as the food log. #2380 made the food half one tap. The stack beside it was
// still three, and the dashboard — the surface a morning actually starts on —
// offered none of it. This module composes the two halves into one offer.
//
// ── IT IS A COMPOSITION, NOT A NEW MEASURE ───────────────────────────────────
//
// Nothing here observes anything. The food half is exactly `usualFoodOffer`'s answer
// (lib/food-regularity.ts) — same 21-day regularity measure, same habitual share,
// same cap-direction and alcohol exclusions (#998/#2380) inherited for free, because
// this module never re-derives them and could not weaken them if it tried. The dose
// half is the profile's OWN DECLARATION read back: a dose whose `time_of_day` buckets
// to this window and which is due today and still unresolved.
//
// ── THE TWO HALVES ARE MEMBERS FOR DIFFERENT REASONS, DELIBERATELY ───────────
//
// Food declares nothing, so a food habit has to be MEASURED. A dose's `time_of_day`
// IS the declaration, so measuring it from co-occurrence would duplicate a stated
// intent with a guess — and a guess is exactly the thing #2419 forbids the app from
// turning into an expectation. So dose membership rides DECLARATION + DUENESS and
// never obligation and never a detected pattern:
//
//   • a `may` item falls out through DUENESS (it is never scheduled-due, #1505/#2419),
//     not through an obligation filter — it stays one tap away on its own rows,
//     collapsed and never filtered;
//   • a paused or situationally-held item falls out through `conditionAppliesOn`;
//   • nothing here reads `obligation` at all. Obligation is declared only, forever.
//
// ── THE FOOD HALF IS THE GATE; THE DOSE HALF IS A RIDER ──────────────────────
//
// With no food offer there is NO CONTROL — not a dose-only "usual". Pending doses on
// their own are already owned by the dashboard's dose confirm and by the reminders,
// and a dose-only bundle would be a worse copy of those. With a food offer and no
// pending doses the control degrades to exactly the food offer that already ships.
//
// ── AND IT IS AN OFFER ───────────────────────────────────────────────────────
//
// The user's tap is the write. The label names EVERY group and EVERY dose the tap
// will perform, and `logUsualRoutineCore` (lib/usual-routine-write.ts) re-derives
// both halves from fresh server state and writes only the intersection — so a stale
// tap refuses instead of logging a second breakfast or a fourth creatine.

import type { FoodSlot } from "./food-slot";
import { PROTEIN_NUDGE_KEY } from "./protein-nudge";

// One dose the offer would confirm. Ids and label material only: the button names it,
// the write core re-resolves it, and nothing downstream reads a dose row from here.
export interface UsualRoutineDose {
  doseId: number;
  itemId: number;
  name: string;
  // The amount/product line beside the name, already formatted by the gather — the
  // same string the reminder keyboards show, so the two surfaces name a dose alike.
  detail: string | null;
  // The item's stack label (#3098) — the profile's OWN name for a group taken
  // together. Feeds the label compression below; null/absent for an unstacked item.
  stack?: string | null;
}

// What one tap would write, both halves. Only ever built when the food half stands.
export interface UsualRoutineOffer {
  window: FoodSlot;
  // Catalog group slugs, share-descending — `usualFoodOffer`'s answer, with the
  // reserved protein key lifted out into `proteinGrams` below.
  groups: string[];
  // THE PROTEIN SCOOP THIS OFFER PROMISES (#4379, owner ruling 2026-08-30), or null when
  // the window has no protein habit standing. Grams rather than a boolean because the
  // offer may never name less or more than the tap writes (#2460): the profile's own
  // preset is resolved AT MINT and carried, so a preset changed between the render and
  // the tap does not move a promise somebody already read.
  proteinGrams: number | null;
  // Declared-in-window, due-today, still-unresolved doses. May be empty: the rider
  // is optional and its absence degrades the control to the plain food offer.
  doses: UsualRoutineDose[];
}

// Compose the two halves into one offer, or `null` for NO CONTROL.
//
// The one rule this function owns: the food half is the gate. `groups` arrives from
// `usualFoodOffer`, which already returns `[]` below `FOOD_USUAL_MIN_GROUPS`, so an
// empty list here means "the food offer does not stand" and the whole control goes.
export function usualRoutineOffer(
  window: FoodSlot,
  groups: readonly string[],
  // The promised scoop, or null when protein is not a member of this window's bundle.
  proteinGrams: number | null,
  doses: readonly UsualRoutineDose[]
): UsualRoutineOffer | null {
  // The food half is still the gate, and protein is now part of that half: it earns its
  // place through the same window measure and the same habitual share as any group
  // (#4379), so a bundle that is one group plus the morning scoop is a bundle. What is
  // still refused is an offer with NO food half at all — a dose-only "usual" is a worse
  // copy of the dose rows that already exist.
  if (groups.length === 0 && proteinGrams === null) return null;
  return { window, groups: [...groups], proteinGrams, doses: [...doses] };
}

// "Berries", "Berries and Fermented foods", "Berries, Eggs and Fermented foods" — the
// names a "log my usual" control says OUT LOUD, in its label and in the toast that
// answers it (#2380). Plain English on purpose: the label has to read as a promise of
// what the tap writes, which is also why the button and its answer format the same
// list through the same function. Shared by the Food tab's food-only control and the
// dashboard's composed one (#2458), so the two can never name a write differently.
// HOW THE BUNDLE NAMES ITS PROTEIN MEMBER — "+30g protein", the vocabulary #1073 already
// ships on the nudge button, minus that surface's glyph. A member of the food half is
// named in the same breath as the groups beside it, which is what "protein behaves
// exactly like a food group" means at the label layer.
export function proteinMemberName(grams: number): string {
  return `+${grams}g protein`;
}

// THE FOOD HALF'S MEMBERS, SLUG-PAIRED WITH THE LABEL THAT PROMISES THEM — one mapping
// for the four surfaces that build it (the dashboard control's props, the quick-log
// sheet's, the record door's day offers, and the chat attachment's line). Each had
// spelled `groups.map(slug => ({ slug, name: foodGroupBySlug(slug)?.name ?? slug }))`
// itself, and #4379 would have added the protein member to all four independently — four
// chances for one bundle to name its own write four ways.
export function usualRoutineFoodMembers(
  offer: Pick<UsualRoutineOffer, "groups" | "proteinGrams">,
  nameOf: (slug: string) => string
): { slug: string; name: string }[] {
  return [
    ...offer.groups.map((slug) => ({ slug, name: nameOf(slug) })),
    ...(offer.proteinGrams === null
      ? []
      : [
          {
            slug: PROTEIN_NUDGE_KEY,
            name: proteinMemberName(offer.proteinGrams),
          },
        ]),
  ];
}

export function namesPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// THE BULK VERB READS BY COUNT (#4477, owner ruling 2026-08-31, amended the same day).
//
// "Take all 1" is a bulk verb over a set of one, which is the surface counting instead
// of saying what the tap does; "Take all 2" spends a number where the set is already
// whole. So the ladder: one NAMES its member, two reads "both", and a count appears
// only from three, where it is the only thing that says how much is about to be
// written. Beside `dosesPhrase` because the ruling is about ANY bulk control over a
// dose set, not about the ledger's row — a second surface spelling this itself is how
// two controls come to promise the same write in two voices.
//
// THE VERB IS THE ONE THING A CALLER STATES (#5320). The composed-usual bundle writes
// SERVINGS as well as dose confirms, and servings are not taken, so its row control
// says "Log". That is a word in the sentence and not a second ladder: the rungs and
// the count are decided here for both verbs, which is what stops the composed control
// from counting differently from the take-all on the row beside it.
export function bulkLabel(
  verb: "Take" | "Log",
  members: readonly Pick<UsualRoutineDose, "name">[]
): string {
  if (members.length === 1) return `${verb} ${members[0]!.name}`;
  if (members.length === 2) return `${verb} both`;
  return `${verb} all ${members.length}`;
}

// The dose half of the label, as the phrase says it (#3098) — exported because the
// recent-past catch-up sheet's per-bucket bulk row makes the SAME promise about the
// same kind of set (#3936), and a second spelling of the compression would let one
// surface name a group the other enumerates. When EVERY rider dose
// (two or more) shares one non-null stack, the enumeration compresses to the
// profile's OWN name for exactly those doses — "Sleep stack (4)" — with the count
// keeping the promise checkable. Mixed riders (two stacks, any unstacked dose) and
// single-dose riders keep the full enumeration: a one-dose rider renamed to its
// stack would name the group while writing one member, which the label-is-a-promise
// doctrine forbids.
export function dosesPhrase(
  doses: readonly Pick<UsualRoutineDose, "name" | "stack">[]
): string {
  const stacks = new Set(doses.map((d) => d.stack?.trim() || null));
  const [only] = stacks;
  if (doses.length >= 2 && stacks.size === 1 && only) {
    return `${only} (${doses.length})`;
  }
  return namesPhrase(doses.map((d) => d.name));
}

// The whole label, both halves, in one sentence: "fermented and berries + creatine,
// collagen and B-complex" — or, when the rider is exactly one whole stack,
// "fermented and berries + Sleep stack (4)" (#3098). The `+` is the seam between two
// DIFFERENT kinds of write — servings and dose confirms — and keeping it visible is
// what stops the sentence from reading as one undifferentiated list of five things.
//
// Pure and shared so the dashboard control, its accessible name and any chat
// surface (#2460) all promise the same writes in the same words — the compression
// lives HERE so no surface can compress differently. The answer text
// (`usualRoutineAnswerText`) is untouched: what was actually written is still
// reported dose by dose, partial truths included.
export function usualRoutinePhrase(
  foodNames: readonly string[],
  doses: readonly Pick<UsualRoutineDose, "name" | "stack">[]
): string {
  const food = namesPhrase(foodNames);
  if (doses.length === 0) return food;
  return `${food} + ${dosesPhrase(doses)}`;
}

// WHAT THE TAP ACTUALLY DID, in one sentence — the shared answer for the dashboard
// toast and the Telegram callback ack (#2458/#2460).
//
// It may never claim more than was written. Every half is reported from what the write
// core RETURNED, never from what the button named: a group the offer had already lost
// is simply absent, and a dose that refused is named as not logged rather than folded
// into a count. "Logged fermented and berries · 3 doses taken" is the happy path;
// "Logged fermented and berries · 2 doses taken · Creatine not logged" is the partial
// truth, and both come out of the same function so no surface can round one up.
export function usualRoutineAnswerText(
  // Group NAMES (not slugs) actually written.
  foodNames: readonly string[],
  // Dose names whose confirm actually moved the ledger.
  dosesLogged: readonly string[],
  // Dose names the write core named but could not log — a paused item, a retired
  // dose, one already resolved from another surface between render and tap.
  dosesRefused: readonly string[]
): string {
  const parts: string[] = [];
  if (foodNames.length > 0) parts.push(`Logged ${namesPhrase(foodNames)}`);
  if (dosesLogged.length > 0)
    parts.push(
      `${dosesLogged.length} dose${dosesLogged.length === 1 ? "" : "s"} taken`
    );
  if (dosesRefused.length > 0)
    parts.push(`${namesPhrase(dosesRefused)} not logged`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing left to log";
}

// THE ANSWER, FROM ONE OUTCOME, IN ONE PLACE (#4438 item 5). Three surfaces render the
// bundle's sentence — the dashboard control, the record door and the nutrition bar —
// and each had spelled the same three filters itself: intersect the NAMED groups with
// the ones the core says it wrote, then split the doses on whether their confirm moved
// the ledger. Three copies of a rounding decision is three chances to round it
// differently, which is the one thing `usualRoutineAnswerText` exists to prevent.
//
// `landed` is spelled here rather than imported from `usualRoutineDoseLogged`, which
// sits beside the write core and would pull the database into a client bundle. The
// outcome arrives as its own string union from the action's typed result, so a value
// this cannot name does not typecheck at the call site.
export function usualRoutineWriteAnswer(
  // What the BUTTON named, slug-paired with the label it promised. A protein member
  // carries the reserved key as its slug, exactly as it does on the wire.
  named: readonly { slug: string; name: string }[],
  written: {
    groups: readonly { groupKey: string }[];
    doses: readonly { name: string; outcome: string }[];
    // Grams the tap actually wrote, or null/absent when protein was not part of it.
    protein?: number | null;
  }
): string {
  const wrote = new Set(written.groups.map((g) => g.groupKey));
  if (written.protein != null) wrote.add(PROTEIN_NUDGE_KEY);
  const landed = (outcome: string) =>
    outcome === "logged" || outcome === "logged-off-day";
  return usualRoutineAnswerText(
    named.filter((f) => wrote.has(f.slug)).map((f) => f.name),
    written.doses.filter((d) => landed(d.outcome)).map((d) => d.name),
    written.doses.filter((d) => !landed(d.outcome)).map((d) => d.name)
  );
}
