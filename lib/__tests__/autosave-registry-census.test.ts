import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A TRIPWIRE FOR A HAZARD THAT DOES NOT EXIST YET (#3352).
//
// THE HAZARD. The dirty-form registry decides "is this field saved?" by comparing the
// control's value against what the server rendered into it. Since #3352 it stops
// trusting a DOM default that has moved onto exactly what the user typed, because
// React syncs `defaultValue` onto a controlled field and the comparison could
// otherwise only ever say "clean". That resolution is deliberate and documented on
// `resolveServerValue` — but it has a cost in the other direction, and the cost is
// NOT the "one extra confirm" the trade-off paragraph there describes:
//
//   A NAMED FIELD INSIDE A `<form>` THAT AUTOSAVES WITHOUT SUBMITTING NEVER RELEASES.
//   Its write lands, the server revalidates the default onto the typed value, and the
//   registry reads that as the ambiguous case and keeps answering "dirty" — forever.
//   A permanently-dirty form holds every chrome refresh back (#1878) and blocks the
//   automatic update reload (#2471). Submitting, resetting or unmounting releases it;
//   an autosave does none of those.
//
// The supported answer is `data-server-value` on the control, which states what the
// server now holds and is preferred over all of the above.
//
// WHY A TEST AND NOT A SENTENCE. Nothing in the tree hits this today: not one
// `useSaveStatus` consumer has a `<form>` containing a control the registry would
// track, which is why #3352 could ship without redesigning autosave. A comment saying
// "future autosaving named fields must set data-server-value" would be true on the day
// it was written and unchecked ever after — the shape #3260 was: an opt-out whose
// stated reason had gone false, with nothing verifying it, and main red three hours a
// day for weeks. This fires the day someone introduces the field.
//
// WHAT "A CONTROL THE REGISTRY WOULD TRACK" MEANS, and it is the whole difficulty.
// `ProviderAffiliations` looks like a tracked form — a `<form>` carrying `name="name"`
// — and is not one, because that name lands on `ProviderCombobox`, whose input is
// `type="hidden"`, which `isTrackable` excludes outright; the visible field the person
// types into carries no name at all. So the question is never "does this file contain
// `name=`?" but "is any name on a control the registry will TRACK?". A census that
// gets that backwards reports a sweep it never took.
//
// Consequently this scan biases toward REPORTING: a `name=` on a capitalized component
// is UNKNOWN (nobody here can see what it renders) and counts as a hit, and a tag it
// cannot parse counts as a hit too. A false alarm costs a reader two minutes; a false
// all-clear costs the thing the tripwire exists for.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Spelled this way rather than as a string escape, so THIS file stays plain text and
// never has to appear in the deliberate-NUL registry (#3206).
const NUL = String.fromCharCode(0);

function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split(NUL)
    .filter(Boolean);
}

const REGISTRY_MODULE = "components/DirtyFormRegistry.tsx";

/**
 * The input `type`s the registry refuses, READ OUT OF THE REGISTRY rather than
 * restated here. A second copy of this list is a second thing to keep in step, and it
 * would fall out of step in the direction that makes this census pass.
 */
function excludedInputTypes(): Set<string> {
  const block = /const NON_INPUT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(
    read(REGISTRY_MODULE)
  );
  if (!block) {
    throw new Error(
      `${REGISTRY_MODULE} no longer declares NON_INPUT_TYPES the way this census reads it — ` +
        `re-point the parse rather than hardcoding the list, or the census silently stops matching the registry`
    );
  }
  return new Set(Array.from(block[1].matchAll(/"([a-z]+)"/g)).map((m) => m[1]));
}

const EXCLUDED_TYPES = excludedInputTypes();
const CONTROL_TAGS = new Set(["input", "textarea", "select"]);

/**
 * The full text of the JSX tag that opens at `src[open]`, brace- and quote-aware so an
 * attribute expression containing `>` cannot truncate it.
 */
function tagExtent(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

interface NamedControl {
  /** The tag as written — `input`, or a component name. */
  tag: string;
  /** Why this counts, in the failure message's own words. */
  why: string;
}

/** Every `name=`-carrying JSX tag in `src` that the registry could track. */
function trackableNamedControls(src: string): NamedControl[] {
  const hits: NamedControl[] = [];
  for (let i = src.indexOf("<"); i >= 0; i = src.indexOf("<", i + 1)) {
    const head = /^<\s*([A-Za-z][A-Za-z0-9_.]*)/.exec(src.slice(i, i + 64));
    if (!head) continue;
    const tag = head[1];
    const extent = tagExtent(src, i);
    if (!/\bname\s*=\s*("|\{)/.test(extent)) continue;

    if (CONTROL_TAGS.has(tag)) {
      const type = /\btype\s*=\s*"([a-z]+)"/.exec(extent)?.[1];
      // A `type={expr}` cannot be read from here, so it is reported rather than
      // assumed benign.
      if (type && EXCLUDED_TYPES.has(type)) continue;
      hits.push({
        tag,
        why: type
          ? `<${tag} type="${type}"> carries a name the registry tracks`
          : `<${tag}> carries a name the registry tracks`,
      });
      continue;
    }
    if (/^[A-Z]/.test(tag)) {
      hits.push({
        tag,
        why:
          `<${tag}> is handed a name, and what it renders that name onto cannot be seen from here — ` +
          `a visible input (Combobox) is tracked, a hidden one (ProviderCombobox, DateField) is not`,
      });
    }
  }
  return hits;
}

const AUTOSAVE_HOOK = "useSaveStatus";

/** Every file that autosaves through the shared hook, excluding the hook itself. */
function autosaveConsumers(): string[] {
  return trackedFiles()
    .filter((rel) => /^(app|components)\/.*\.tsx$/.test(rel))
    .filter((rel) => new RegExp(`\\b${AUTOSAVE_HOOK}\\b`).test(read(rel)))
    .sort();
}

/** Files that render `<Component`, i.e. could be the one supplying it a `<form>`. */
function renderSitesOf(component: string): string[] {
  const open = new RegExp(`<${component}[\\s/>]`);
  return trackedFiles()
    .filter((rel) => /^(app|components)\/.*\.tsx$/.test(rel))
    .filter((rel) => open.test(read(rel)))
    .sort();
}

function componentNamesIn(rel: string): string[] {
  const base = path.basename(rel).replace(/\.tsx$/, "");
  return [base];
}

describe("autosaving forms and the dirty-form registry (#3352)", () => {
  const consumers = autosaveConsumers();

  it("finds the autosave surfaces at all, and can tell a tracked control from an excluded one", () => {
    // ANTI-VACUITY. Every claim below is "we looked and found nothing", which is also
    // what a scan that matches nothing reports. So: the census sees real files, the
    // exclusion list came off the registry, and the classifier answers correctly on
    // both a shape that IS tracked and the two shapes that are not.
    expect(consumers.length).toBeGreaterThan(20);
    expect(EXCLUDED_TYPES.has("hidden")).toBe(true);
    expect(EXCLUDED_TYPES.has("file")).toBe(true);

    expect(
      trackableNamedControls(`<input name="dose" className="input" />`)
    ).toHaveLength(1);
    expect(
      trackableNamedControls(`<textarea name="notes" defaultValue={n} />`)
    ).toHaveLength(1);
    // The ProviderAffiliations shape, both halves: the hidden input is excluded, and
    // the wrapper that renders one is reported because nobody here can tell which
    // wrapper it is.
    expect(
      trackableNamedControls(`<input type="hidden" name="id" value={x} />`)
    ).toHaveLength(0);
    expect(
      trackableNamedControls(`<ProviderCombobox name="name" id="a" />`)
    ).toHaveLength(1);
    // And a tag whose attribute expression contains a `>` must not truncate.
    expect(
      trackableNamedControls(`<input onKeyDown={(e) => go(e)} name="x" />`)
    ).toHaveLength(1);
  });

  it("no autosaving surface renders a <form> around a control the registry tracks", () => {
    const offenders = consumers
      .filter((rel) => /<form[\s>]/.test(read(rel)))
      .flatMap((rel) =>
        trackableNamedControls(read(rel)).map((c) => `${rel}: ${c.why}`)
      );
    expect(
      offenders,
      "An autosaving <form> with a registry-tracked control never releases: its write lands, " +
        "the server revalidates the DOM default onto the typed value, and the registry reads that " +
        "as the ambiguous case in resolveServerValue and answers dirty forever — holding back every " +
        "chrome refresh (#1878) and the automatic update reload (#2471). Set data-server-value on the " +
        "control to state what the server now holds, or keep the field out of the autosaving <form>."
    ).toEqual([]);
  });

  it("nor does the surface that renders one, which is where the <form> would come from", () => {
    // THE HALF THAT ALMOST GOT MISSED. Two autosave consumers DO carry named controls
    // — EmailNotificationSettings and ServerTelegramSettings, each a pair of
    // `type="radio"` inputs, which the registry tracks — and neither file contains a
    // `<form>`. They are safe only because the page that renders them has none either,
    // and `isTrackable` requires `field.form`. That is a fact in ANOTHER file, so
    // checking only the consumer would have reported a clean sweep resting on
    // something nothing verified.
    //
    // BOUNDED, AND THE BOUND IS THE POINT: one level of ancestry, the consumer's
    // direct render sites. Walking further reaches layout files that contain some
    // unrelated `<form>` and the census turns into noise. If a surface ever nests
    // deeper than this inside a form, this scan will not see it.
    const offenders: string[] = [];
    for (const rel of consumers) {
      const controls = trackableNamedControls(read(rel));
      if (controls.length === 0) continue;
      for (const component of componentNamesIn(rel)) {
        for (const site of renderSitesOf(component)) {
          if (site === rel) continue;
          if (!/<form[\s>]/.test(read(site))) continue;
          offenders.push(
            `${rel} (${controls[0].why}) rendered inside a <form> by ${site}`
          );
        }
      }
    }
    expect(
      offenders,
      "Same hazard as above, one file up: the autosaving component carries a tracked control and " +
        "its render site supplies the <form> that makes it visible to the registry. Set " +
        "data-server-value on the control, or keep it out of the form."
    ).toEqual([]);
  });
});
