import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CategoryFilterSelect from "@/components/CategoryFilterSelect";
import PanelFilterSelect from "@/components/PanelFilterSelect";
import RangeFilterSelect from "@/components/RangeFilterSelect";

// The three query-backed filter selects (#3748) share one owner, so their URL
// contract is proved once as a table rather than three times as prose. The write
// path is the whole claim: a filter change must move ITS OWN param and nothing
// else, because the surfaces these sit on carry a search term and a sort in the
// same query string and a filter that rebuilt the URL would silently clear them.
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

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.path = "/results/clinical-results";
  nav.search = "";
});

// `path` differs per row on purpose: these controls are path-agnostic and the
// range filter really does render on a document subpage as well as the catalog,
// so a row that pinned one pathname would not be testing that.
const CASES = [
  {
    name: "Category",
    param: "category",
    path: "/results/clinical-results",
    others: "q=chol&sort=name",
    current: "vitals",
    pick: "lab",
    node: () => (
      <CategoryFilterSelect value="vitals" categories={["lab", "vitals"]} />
    ),
  },
  {
    name: "Panel",
    param: "panel",
    path: "/results/clinical-results",
    others: "q=chol&sort=name",
    current: "lipids",
    pick: "thyroid",
    node: () => (
      <PanelFilterSelect value="lipids" panels={["lipids", "thyroid"]} />
    ),
  },
  {
    name: "Show",
    param: "range",
    path: "/import/12",
    others: "tab=results&q=chol",
    current: "oor",
    pick: "nonoptimal",
    node: () => <RangeFilterSelect value="oor" />,
  },
] as const;

describe.each(CASES)(
  "$name query filter writes the URL (#3748)",
  ({ name, param, path, others, current, pick, node }) => {
    function mount(search: string) {
      nav.path = path;
      nav.search = search;
      render(node());
      return screen.getByRole("combobox", { name });
    }

    it("associates its label with the select and shows the active value", () => {
      const select = mount(`${others}&${param}=${current}`);
      expect((select as HTMLSelectElement).value).toBe(current);
    });

    it("preserves the pathname and every unrelated param", () => {
      fireEvent.change(mount(`${others}&${param}=${current}`), {
        target: { value: pick },
      });
      expect(nav.push).toHaveBeenCalledWith(
        `${path}?${others}&${param}=${pick}`
      );
    });

    it("deletes its own param on the default value, keeping the others", () => {
      fireEvent.change(mount(`${others}&${param}=${current}`), {
        target: { value: "" },
      });
      expect(nav.push).toHaveBeenCalledWith(`${path}?${others}`);
    });

    it("drops the whole query string when its param was the only one", () => {
      fireEvent.change(mount(`${param}=${current}`), {
        target: { value: "" },
      });
      expect(nav.push).toHaveBeenCalledWith(path);
    });
  }
);

// The range filter's sessionStorage memory is the CALL SITE's policy, not the
// shared owner's (#3748 is explicit). These pin it where it lives, so a later
// change to the owner cannot quietly take it away or hand it to the other two.
describe("the range filter's session memory stays outside the owner (#3748)", () => {
  const KEY = "medical:range";

  it("remembers a chosen value and forgets it on All", () => {
    nav.search = "range=oor";
    render(<RangeFilterSelect value="oor" />);
    const select = screen.getByRole("combobox", { name: "Show" });

    fireEvent.change(select, { target: { value: "nonoptimal" } });
    expect(sessionStorage.getItem(KEY)).toBe("nonoptimal");

    fireEvent.change(select, { target: { value: "" } });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("restores the remembered value on mount, preserving other params", () => {
    sessionStorage.setItem(KEY, "nonoptimal");
    nav.search = "tab=results&q=chol";
    render(<RangeFilterSelect />);
    expect(nav.replace).toHaveBeenCalledWith(
      "/results/clinical-results?tab=results&q=chol&range=nonoptimal"
    );
  });

  it("lets an explicit param in the URL beat the remembered value", () => {
    sessionStorage.setItem(KEY, "nonoptimal");
    nav.search = "range=oor";
    render(<RangeFilterSelect value="oor" />);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("leaves the other two filters with no session memory of their own", () => {
    nav.search = "category=vitals";
    render(<CategoryFilterSelect value="vitals" categories={["lab", "vitals"]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), {
      target: { value: "lab" },
    });
    expect(sessionStorage.length).toBe(0);
  });
});
