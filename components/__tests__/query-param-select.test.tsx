import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MedicalFilters from "@/components/MedicalFilters";
import RangeFilterSelect from "@/components/RangeFilterSelect";
import type { PanelId } from "@/lib/biomarker-panels";

// The query-backed filter selects share one owner (#3748), so their URL contract is
// proved once as a table rather than three times as prose — and it is driven through
// MedicalFilters, the surface that actually mounts them, because the whole claim is
// about what happens to the params SITTING BESIDE the one being changed. This page
// carries a search term and the table's sort in the same query string, and a filter
// that rebuilt the URL instead of cloning it would silently clear them.
//
// THESE ARE NOT PHONE COVERAGE, and the distinction is load-bearing. Below `sm` the
// facets sit behind the Filters disclosure as ONE authored group that CSS hides
// (`class="hidden"`, never a second render) — and jsdom applies no stylesheet, so
// every test here drives controls a real 390px phone keeps closed. If that group
// ever became a conditional render, the phone would lose all three filters and this
// file would stay green. The disclosure belongs to the e2e tier
// (results-panel-groups.mobile, biomarker-panels); geometry does too, since jsdom
// lays nothing out.
const nav = vi.hoisted(() => ({
  path: "/results/clinical-results",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const OTHERS = "q=chol&sort=name&dir=asc";
const PANELS = ["lipids", "thyroid", "other"] as const;

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.path = "/results/clinical-results";
  nav.search = "";
});

// The page resolves these params on the SERVER and hands them down, so the fixture
// derives the props from the same query string the router is reporting — anything
// else would be testing a state the route cannot produce.
function mountFilters(search: string) {
  nav.search = search;
  const sp = new URLSearchParams(search);
  render(
    <MedicalFilters
      panels={PANELS}
      category={sp.get("category") ?? undefined}
      panel={(sp.get("panel") as PanelId | null) ?? undefined}
      range={sp.get("range") ?? undefined}
      q={sp.get("q") ?? undefined}
    />
  );
}

const CASES = [
  { name: "Category", param: "category", current: "vitals", pick: "lab" },
  { name: "Panel", param: "panel", current: "lipids", pick: "thyroid" },
  { name: "Show", param: "range", current: "oor", pick: "nonoptimal" },
] as const;

describe.each(CASES)(
  "the $name filter writes the URL (#3748)",
  ({ name, param, current, pick }) => {
    function select(search: string) {
      mountFilters(search);
      return screen.getByRole("combobox", { name });
    }

    it("labels the select and shows the value the URL names", () => {
      const el = select(`${OTHERS}&${param}=${current}`) as HTMLSelectElement;
      expect(el.value).toBe(current);
    });

    it("preserves the pathname and every unrelated param", () => {
      fireEvent.change(select(`${OTHERS}&${param}=${current}`), {
        target: { value: pick },
      });
      expect(nav.push).toHaveBeenCalledWith(
        `/results/clinical-results?${OTHERS}&${param}=${pick}`
      );
    });

    it("deletes its own param on the default value, keeping the others", () => {
      fireEvent.change(select(`${OTHERS}&${param}=${current}`), {
        target: { value: "" },
      });
      expect(nav.push).toHaveBeenCalledWith(
        `/results/clinical-results?${OTHERS}`
      );
    });

    it("drops the whole query string when its param was the only one", () => {
      fireEvent.change(select(`${param}=${current}`), {
        target: { value: "" },
      });
      expect(nav.push).toHaveBeenCalledWith("/results/clinical-results");
    });

    it("moves its own param and no other", () => {
      mountFilters(`${OTHERS}&category=vitals&panel=lipids&range=oor`);
      fireEvent.change(screen.getByRole("combobox", { name }), {
        target: { value: pick },
      });
      const url = new URL(String(nav.push.mock.calls[0][0]), "https://x");
      for (const [k, v] of Object.entries({
        category: "vitals",
        panel: "lipids",
        range: "oor",
      })) {
        expect(url.searchParams.get(k)).toBe(k === param ? pick : v);
      }
    });
  }
);

// The range filter's sessionStorage memory is the CALL SITE's policy, not the shared
// owner's (#3748 is explicit). These pin it where it lives, so a later change to the
// owner cannot quietly take it away or hand it to the other two.
describe("the range filter's session memory stays outside the owner (#3748)", () => {
  const KEY = "medical:range";

  it("remembers a chosen value and forgets it on All", () => {
    mountFilters("range=oor");
    const select = screen.getByRole("combobox", { name: "Show" });

    fireEvent.change(select, { target: { value: "nonoptimal" } });
    expect(sessionStorage.getItem(KEY)).toBe("nonoptimal");

    fireEvent.change(select, { target: { value: "" } });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  // Mounted on a document subpage, not the catalog: the control is path-agnostic and
  // this call site (ExtractedObservations) is the reason it has to be.
  it("restores the remembered value on mount, preserving path and params", () => {
    sessionStorage.setItem(KEY, "nonoptimal");
    nav.path = "/import/12";
    nav.search = "tab=results&q=chol";
    render(<RangeFilterSelect />);
    expect(nav.replace).toHaveBeenCalledWith(
      "/import/12?tab=results&q=chol&range=nonoptimal"
    );
  });

  it("lets an explicit param in the URL beat the remembered value", () => {
    sessionStorage.setItem(KEY, "nonoptimal");
    nav.search = "range=oor";
    render(<RangeFilterSelect value="oor" />);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("leaves the category and panel filters with no memory of their own", () => {
    mountFilters("category=vitals&panel=lipids");
    for (const [name, value] of [
      ["Category", "lab"],
      ["Panel", "thyroid"],
    ]) {
      fireEvent.change(screen.getByRole("combobox", { name }), {
        target: { value },
      });
    }
    expect(sessionStorage.length).toBe(0);
  });
});
