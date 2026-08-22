import { describe, expect, it } from "vitest";
import { pageDeclaresUnrecoverableWork } from "../DirtyFormRegistry";

// `pageDeclaresUnrecoverableWork()` — the DOM half of the #3371 reload gate, and the
// first customer of the component tier (#3446).
//
// WHAT WAS UNPINNED, precisely. The PREDICATE it applies to each element,
// `declarationBlocksAutomaticReload`, is pure and already covered in
// lib/__tests__/dirty-forms.test.ts. What nothing could see was the SCAN that feeds
// it: which elements are visited, what `declared` and `draftBacked` are read from,
// and whether the loop keeps going after the first element it decides about. That is
// a `querySelectorAll` over a real document, so before this tier the only tier that
// could reach it was a full service-worker-update e2e scenario — and the DOM scan is
// on the path where being wrong costs the person their typing.
//
// The whole page is the fixture, because the whole page is what the function reads:
// it takes no argument and scans `document`.

/** Put `html` on the page, exactly as the function under test will find it. */
function page(html: string): void {
  document.body.innerHTML = html;
}

describe("pageDeclaresUnrecoverableWork (#3371 declaration axis)", () => {
  it("is silent on a page that declares nothing", () => {
    page(`<form><input name="weight" /></form>`);
    expect(pageDeclaresUnrecoverableWork()).toBe(false);
  });

  it("sees a hand-composed form that declares unsaved work", () => {
    page(`<div data-unsaved="true">half-typed sleep note</div>`);
    expect(pageDeclaresUnrecoverableWork()).toBe(true);
  });

  it("reads the declaration's VALUE, so a form that has gone clean is silent", () => {
    // The marker is rendered unconditionally and flipped, not added and removed —
    // `data-unsaved="false"` is the resting state of a live declarer, not an absence.
    page(`<div data-unsaved="false">nothing typed yet</div>`);
    expect(pageDeclaresUnrecoverableWork()).toBe(false);
  });

  it("excludes a declarer inside a draft-backed subtree", () => {
    // The exclusion is only sound because the flush is real: a draft-backed form's
    // content is in IndexedDB before the reload, so the reload does not destroy it.
    // See the header on `pageDeclaresUnrecoverableWork` and #3371's fix round.
    page(`
      <div data-draft-backed>
        <section><div data-unsaved="true">typed into an autosaving form</div></section>
      </div>
    `);
    expect(pageDeclaresUnrecoverableWork()).toBe(false);
  });

  it("excludes a declarer that is draft-backed on the SAME element", () => {
    // `closest()` starts at the element itself, and ActivityForm stamps both
    // attributes on one node — so this is the shipped shape, not a corner case.
    page(`<div data-unsaved="true" data-draft-backed>ActivityForm</div>`);
    expect(pageDeclaresUnrecoverableWork()).toBe(false);
  });

  it("keeps looking after an excluded declarer, so a second one still holds the tab", () => {
    // THE CASE A SCAN THAT RETURNS TOO EARLY GETS WRONG. Two editors open at once is
    // ordinary — an autosaving activity form behind a sleep-mood dialog — and if the
    // draft-backed one is visited first, a scan that answers on the first element it
    // examines reports "nothing to lose" and the tab reloads over the dialog.
    page(`
      <div data-draft-backed><div data-unsaved="true">autosaved</div></div>
      <div data-unsaved="true">SleepMoodEditDialog</div>
    `);
    expect(pageDeclaresUnrecoverableWork()).toBe(true);
  });

  it("finds a declarer nested deep inside ordinary chrome", () => {
    page(`
      <main><section><div class="card"><form>
        <fieldset><div data-unsaved="true">ProviderAffiliations</div></fieldset>
      </form></div></section></main>
    `);
    expect(pageDeclaresUnrecoverableWork()).toBe(true);
  });
});
