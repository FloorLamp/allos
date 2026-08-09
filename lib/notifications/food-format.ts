// Pure rendering for the Telegram food-log nudge (issue #682) — DB-free so it's
// unit-tested (lib/__tests__). The gather (lib/notifications/food.ts) ranks the
// profile's food groups by recency-decayed frequency (rankFoodGroups — the
// SAME "most eaten leads" computation the /nutrition log bar uses, #591/#195) and
// hands the ranked list + today's serving counts here. One tap on a group button
// logs one serving; unlike a dose reminder the buttons are NOT consumed (you can eat
// several servings / several groups), so a rebuild after a tap keeps every button
// and only refreshes the per-button count + the tally line.

import { foodGroupBySlug, foodGroupEmoji, foodGroupName } from "../food-groups";
import { FOOD_QUICK_COUNT } from "../food-rank";
import type { ProteinNudgeLineParts } from "../protein";
import { bold, joinBody, richFrom, type MessageBody } from "./rich-text";
import { formatRichMessageLine } from "./message-line";
import {
  DEFAULT_PROTEIN_PRESET_GRAMS,
  isProteinNudgeKey,
  proteinNudgeButtonLabel,
} from "../protein-nudge";
import type { CorrectionBurst } from "../correction-time";
import {
  correctionActions,
  correctionBodyStatement,
  correctionPickerActions,
  correctionPickerTitle,
  FOOD_TIME_PREFIXES,
} from "./correction-rows";
import type { NotificationAction, NotificationMessage } from "./types";

// The food nudge rides the morning/midday/evening supplement slots (issue #682) —
// NOT Bedtime (logging food at bedtime is noise). A distinct type from the
// supplement ReminderWindow so the two schedules can't be accidentally conflated.
export type FoodNudgeWindow = "Morning" | "Midday" | "Evening";
export const FOOD_NUDGE_WINDOWS: readonly FoodNudgeWindow[] = [
  "Morning",
  "Midday",
  "Evening",
];

// How many of the top-ranked groups become quick-log buttons — and, since #1075, the
// PAGE SIZE both directions of the expansion step by — is FOOD_QUICK_COUNT, imported
// from lib/food-rank beside the ranking whose head it takes (#2225). It is the SAME
// number of fast affordances the web log bar renders, and it is one constant so the two
// surfaces agree by construction rather than by coincidence. The long tail is reached
// with "➕ Show more", never by leaving the chat (#1807 retired the "＋ More…" deep link:
// the nudge's job is one-tap logging in place, and a link to /nutrition on every send
// bought a keyboard row that answered a question the ranked buttons already answer).
// Two buttons per row (see rowFor) → an even count fills rows cleanly.

// The callback token a food quick-log button carries:
//   food:<profileId>:<window>:<date>:<slug>
// profileId is a cross-check (the handler re-resolves the acting profile from the
// chat id); window + date let a late tap rebuild the right message and log to the
// right day; the slug (snake_case, no colons) is the greedy tail. Kept well under
// Telegram's 64-byte callback_data cap.
export function foodLogCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  slug: string
): string {
  return `food:${profileId}:${window}:${date}:${slug}`;
}

// The protein "+Xg" quick-log button token (#1073):
//   foodprotein:<profileId>:<window>:<date>:<grams>
// Mirrors the food-log token (profileId is a cross-check; window + date let a late tap
// rebuild the right message and log to the right day); grams is the last-used scoop preset
// baked in at send time, applied by addProteinGramsCore on tap. Kept under Telegram's
// 64-byte callback cap.
export function foodProteinCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  grams: number
): string {
  return `foodprotein:${profileId}:${window}:${date}:${grams}`;
}

// The "➕ Show more" progressive-expansion token (#1075):
//   foodmore:<profileId>:<window>:<date>
// It carries NO count — expansion state IS the rendered keyboard, so the handler derives
// the current visible count by counting the ranked buttons already present and rebuilds at
// count + FOOD_QUICK_COUNT (stateless; a fresh nudge always resets to the compact
// default).
export function foodMoreCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string
): string {
  return `foodmore:${profileId}:${window}:${date}`;
}

// The "➖ Show less" collapse token (#1807, the direction deferred from #1075):
//   foodless:<profileId>:<window>:<date>
// The exact mirror of foodMoreCallbackData and equally stateless — it carries NO count,
// so the handler derives the current visible count from the keyboard and rebuilds at
// max(FOOD_QUICK_COUNT, current − FOOD_QUICK_COUNT). The clamp is what makes
// a double-tap harmless: collapsing bottoms out at the compact default a fresh send uses,
// never at an empty keyboard.
export function foodLessCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string
): string {
  return `foodless:${profileId}:${window}:${date}`;
}

// Count the ranked quick-log buttons currently in a nudge keyboard (#1075). Expansion is
// STATELESS — the number of visible ranked buttons IS the current visibleCount — so a
// handler reads it back off cq.message.reply_markup to preserve, extend, or reduce the
// expansion. Counts food-group (food:…) AND protein (foodprotein:…) buttons; IGNORES the
// tally line (not a button), the view-control row ("Show more"/"Show less", foodmore:… /
// foodless:…), and any opt-in row.
export function countVisibleFoodButtons(
  keyboard:
    | readonly (readonly {
        text?: string;
        callback_data?: string;
        url?: string;
      }[])[]
    | undefined
): number {
  let n = 0;
  for (const row of keyboard ?? []) {
    for (const btn of row) {
      const d = btn.callback_data;
      if (
        typeof d === "string" &&
        (/^food:\d+:/.test(d) || /^foodprotein:\d+:/.test(d))
      )
        n++;
    }
  }
  return n;
}

// The callback token for the one-time first-connection opt-in prompt (#682):
//   foodoptin:<profileId>:<yes|no>
// Answered by a button tap (inbound Telegram is callback-only — there's no /start or
// free-text parser), which flips the per-profile food_telegram_enabled flag.
export function foodOptInCallbackData(
  profileId: number,
  enable: boolean
): string {
  return `foodoptin:${profileId}:${enable ? "yes" : "no"}`;
}

// The protein status line, with the FIGURE emphasized and the status stated in words
// (#1710). Above the band reads as REACHED, never as a warning — protein overshoot
// isn't a problem — and below the band is a neutral marker: no nag, no praise. The
// classification itself is lib/protein's `proteinTodayStatus`, shared with every other
// surface that states a conclusion (#221).
function proteinBody(
  parts: ProteinNudgeLineParts | string | null | undefined
): MessageBody | null {
  if (!parts) return null;
  // No goal band ⇒ no conclusion to state, and none is invented.
  if (typeof parts === "string") return parts;
  // The ONE grammar, with the figure emphasized (#1822 item 4 / #2391): the parts
  // already separate amount/band/status, so the plain and the emphasized rendering can
  // only differ in emphasis, never in what they claim or how they are punctuated.
  return formatRichMessageLine({
    glyph: parts.emoji,
    head: ["Protein: ", bold(parts.amount), " so far"],
    notes: [`goal ${parts.band}`, parts.statusWords],
  });
}

// Two buttons per keyboard row, so six groups render as a tidy 3×2 grid.
function rowFor(index: number): string {
  return `food${Math.floor(index / 2)}`;
}

// The day-total tally line (#1016): groups with a positive count TODAY, most-logged first
// (name breaks ties), labeled so a slot-framed message makes clear the tally answers "where
// am I on the DAY" (the buttons answer "what have I had this SLOT"): "✓ Today: Leafy greens
// ×2 · Berries ×1". Reads the DAY counter (food_log via getFoodServingsOnDate), never the
// slot counts. Empty string when nothing's been logged yet today (the caller shows the
// prompt instead). The reserved __protein__ key can't appear (it never lands in food_log),
// but is filtered defensively so it can never leak into the food-serving tally (#1073).
function tallyLine(dayServings: Map<string, number>): MessageBody | null {
  const logged = [...dayServings.entries()]
    .filter(([slug, n]) => n > 0 && !isProteinNudgeKey(slug))
    .map(([slug, n]) => ({
      emoji: foodGroupEmoji(slug),
      name: foodGroupName(slug),
      n,
    }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (logged.length === 0) return null;
  // The group NAMES carry the emphasis (#1710) — one or the other, never both, since
  // the line already wraps on a phone — and each is led by its catalog glyph, which is
  // what makes a five-group tally scannable rather than a run-on sentence. The counts
  // stay plain so the eye lands on WHAT was eaten first.
  const parts: (string | ReturnType<typeof bold>)[] = ["✓ Today: "];
  logged.forEach((x, i) => {
    if (i > 0) parts.push(" · ");
    if (x.emoji) parts.push(`${x.emoji} `);
    parts.push(bold(x.name));
    parts.push(` ×${x.n}`);
  });
  return richFrom(parts);
}

// Options for renderFoodNudge (the growing set of #974/#1073/#1075 knobs), so the
// positional signature stays stable while behavior is added.
export interface FoodNudgeRenderOpts {
  // Today-vs-goal protein status (issue #974 / day-grams line #1073), gathered as PARTS
  // (#1710) so the classification is decided once in lib/protein and only the emphasis
  // is decided here. Null/omitted when there's no target and no logged protein, so the
  // nudge never carries a bare "0 g" nag. Rendered on its own line, distinct from the
  // tally.
  // A plain string is the no-target case (#1073): grams logged but no band to compare
  // against, so it states the figure and claims NOTHING about a goal.
  proteinLine?: ProteinNudgeLineParts | string | null;
  // How many ranked buttons to show (#1075 progressive expansion). Defaults to
  // FOOD_QUICK_COUNT so every existing send starts compact; "Show more" bumps it.
  visibleCount?: number;
  // Grams for the "+Xg protein" button label (#1073) — the profile's last-used scoop
  // preset. Only used when the reserved __protein__ key falls within the visible window.
  proteinPresetGrams?: number;
  // The eating-time correction rows (#2019), already derived from ledger state by the
  // gather. A RIDE-ALONG: no nudge is ever sent because a burst is correctable, and the
  // rows simply appear on whichever food keyboard is live while the taps are fresh.
  //
  // The bursts travel WITH the instant the chips are bounded against (#2206), the way the
  // picker below already carries its own `now`: a chip is dropped when its step would walk
  // the burst further back than the picker itself reaches, so a caller that could supply
  // the bursts but not the bound would render exactly the unbounded button this issue took
  // off the keyboard. Pairing them makes that combination unspellable rather than silently
  // dropping the rows.
  corrections?: { bursts: readonly CorrectionBurst[]; now: Date };
  // The profile's timezone, for the correction rows' wall-clock labels. Only read when
  // there are corrections to render.
  tz?: string;
  // An OPEN eating-time picker (#2019): the burst whose 🕐 was tapped, plus the instant
  // its offered hours are computed from. The picker replaces the correction ROWS and
  // leaves the quick-log buttons standing — deliberately unlike the `symp:`→`symsev:`
  // drill-down it otherwise copies, because food logging is this message's whole job and
  // hiding it behind a time question would be a worse trade than the extra keyboard rows.
  // Keeping them also means the `food:` tokens survive, so `↩︎ Back` can rebuild the exact
  // nudge from the live keyboard rather than guessing at a window.
  picker?: { burst: CorrectionBurst; now: Date };
}

// Build the food-log nudge for a window from the profile's RANKED keys (all of them,
// staples first, possibly including the reserved __protein__ pseudo-group, #1073), the
// SLOT-scoped per-group counts (#1016 button "(n)" suffix), and the DAY-total counts (the
// tally line). Renders the top `visibleCount` (default FOOD_QUICK_COUNT) ranked keys
// as quick-log buttons — a food group logs one serving, the __protein__ key logs the grams
// preset — plus a view-control row carrying "➕ Show more" while ranked keys remain below
// the fold (#1075) and "➖ Show less" once the keyboard is expanded past the compact
// default (#1807). No deep link: the keyboard is the whole surface (#1807).
export function renderFoodNudge(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  // Ranked keys: catalog food-group slugs, possibly with the reserved __protein__ pseudo-
  // group at its ranked position (#1073).
  rankedKeys: string[],
  // Day-total per-group counts — BOTH the button "(n)" suffix and the "✓ Today:" tally.
  //
  // THE SUFFIX USED TO BE SLOT-SCOPED (#1016) and #2019 retired that meaning. The slot it
  // counted was derived at read time from the tap instant, which is precisely the guess
  // #2019 removes: with the nudge's window no longer written onto the event as a declared
  // meal, a "this slot" count would have to re-derive one, and a tap landing minutes past
  // a boundary would tick nobody's button. The DAY total is a number the ledger can always
  // answer, it is the number the tally line already states, and it is what "(2)" most
  // naturally reads as on a button you have pressed twice today.
  dayServings: Map<string, number>,
  opts: FoodNudgeRenderOpts = {}
): NotificationMessage {
  const visibleCount = opts.visibleCount ?? FOOD_QUICK_COUNT;
  const visible = rankedKeys.slice(0, Math.max(0, visibleCount));
  const presetGrams = opts.proteinPresetGrams ?? DEFAULT_PROTEIN_PRESET_GRAMS;

  const actions: NotificationAction[] = [];
  visible.forEach((key, i) => {
    // The reserved protein pseudo-group (#1073) → the "+Xg protein" button (its own token,
    // its own write core). It carries the SAME "(n)" suffix as every food-group sibling
    // (issue #1379, REVERSING the original #1073 no-suffix decision): a bare button was
    // the only count-less one on the keyboard and read as inconsistency — a user who
    // tapped +Xg twice saw every OTHER button acknowledge its taps and this one not. The
    // count is "n protein logs today" (not grams) — the DAY total, exactly as the
    // sibling buttons count since #2019 retired the slot-scoped suffix — so the keyboard
    // has one count language; the day's total grams stay on their own protein line (the
    // two express taps vs grams). The count needs no window derivation: a protein tap
    // writes a __protein__ row to food_log_events (addProteinGramsCore), the caller
    // counts those taps off that ledger (getProteinTapsOnDate) and merges them into the
    // `dayServings` map every button reads, and the callback rebuild re-reads it so a
    // tap ticks its own button immediately.
    if (isProteinNudgeKey(key)) {
      const base = proteinNudgeButtonLabel(presetGrams);
      const n = dayServings.get(key) ?? 0;
      actions.push({
        label: n > 0 ? `${base} (${n})` : base,
        data: foodProteinCallbackData(profileId, window, date, presetGrams),
        row: rowFor(i),
      });
      return;
    }
    const g = foodGroupBySlug(key);
    if (!g) return; // a retired/unknown slug can't render a button (belt; rankedKeys are catalog)
    const n = dayServings.get(key) ?? 0;
    // The catalog glyph leads the label (#1710) — the same vocabulary the tally and the
    // web food bar use, which is what makes the 3×2 grid readable at a glance.
    const emoji = foodGroupEmoji(key);
    const name = emoji ? `${emoji} ${g.name}` : g.name;
    actions.push({
      label: n > 0 ? `${name} (${n})` : name,
      data: foodLogCallbackData(profileId, window, date, key),
      row: rowFor(i),
    });
  });

  // #1075: reveal the next FOOD_QUICK_COUNT ranked buttons in place — present only
  // while ranked keys remain below the fold (drops automatically once all are shown).
  if (visibleCount < rankedKeys.length) {
    actions.push({
      label: "➕ Show more",
      data: foodMoreCallbackData(profileId, window, date),
      row: "food-showmore",
    });
  }

  // #1807: the collapse direction, symmetric with the above and sharing its row — so a
  // mid-expansion keyboard reads "➕ Show more · ➖ Show less" side by side and a fully
  // expanded one carries "➖ Show less" alone, exactly as "Show more" drops once
  // everything is shown. The default compact send never carries it.
  //
  // The test is `visible.length`, not `visibleCount`: the two differ only when a pointer
  // asks for more buttons than there are ranked keys, and what the user can act on is the
  // number of buttons ACTUALLY rendered — which is also what countVisibleFoodButtons reads
  // back. Testing the request instead would render a collapse button that collapses to the
  // same keyboard (a profile with 4 ranked keys at visibleCount 12 shows 4 either way), and
  // a button whose tap changes nothing is a small lie of the kind this codebase does not
  // ship.
  if (visible.length > FOOD_QUICK_COUNT) {
    actions.push({
      label: "➖ Show less",
      data: foodLessCallbackData(profileId, window, date),
      row: "food-showmore",
    });
  }

  // The correction ride-along goes LAST, below the view controls: the nudge's own
  // buttons are its subject, and `owningFamily` reads the keyboard in order, so the
  // message stays owned by the food quick-log tokens that lead it.
  const tz = opts.tz;
  // The ride-along renders only when it has everything it needs: the bursts, the instant
  // that bounds their chips, and the zone the labels are spelled in.
  const corrections =
    opts.corrections && opts.corrections.bursts.length > 0 && tz
      ? { ...opts.corrections, tz }
      : null;
  if (opts.picker && tz) {
    actions.push(
      ...correctionPickerActions(
        FOOD_TIME_PREFIXES,
        profileId,
        opts.picker.burst,
        opts.picker.now,
        tz
      )
    );
  } else if (corrections) {
    actions.push(
      ...correctionActions(
        FOOD_TIME_PREFIXES,
        profileId,
        corrections.bursts,
        corrections.tz,
        corrections.now
      )
    );
  }

  const tally = tallyLine(dayServings);
  // The prompt falls away once anything is logged (#1710): with a tally present, "Tap
  // what you've eaten to log a serving" is redundant chrome on a small screen — the
  // buttons are right there, and the tally is the information.
  const body = joinBody(
    [
      tally ? null : "Tap what you've eaten to log a serving.",
      tally,
      proteinBody(opts.proteinLine),
      // Stated once, above the rows, rather than repeated on every chip: the row names
      // WHAT it is about, and the sentence says what the numbers do.
      opts.picker && tz
        ? correctionPickerTitle("when did you eat", opts.picker.burst, tz)
        : corrections
          ? // Says what the chips now SAY (#2206): each one names the time it will store,
            // so the sentence only has to explain that they can be pressed again.
            "🕐 Ate earlier than you tapped? Each chip shows the time it sets — press again to go further, or tap the row for an exact time."
          : null,
      // The statement of record (#2264 bug 1): once a burst is corrected, the BODY names
      // the stored time — the row's label states it too, but Telegram truncates buttons
      // and a clipped `(cor…` is not a statement. Uncorrected bursts add nothing.
      corrections
        ? correctionBodyStatement(corrections.bursts, corrections.tz)
        : null,
    ],
    "\n"
  );

  return { title: `🍽️ ${window} food log`, body, actions, kind: "food" };
}
