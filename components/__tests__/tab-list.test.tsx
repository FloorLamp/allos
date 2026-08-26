import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentPropsWithRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import TabList from "@/components/TabList";
import TabFirstTabs from "@/components/TabFirstTabs";
import {
  DATA_TAB_FIRST_PAGE,
  RECORDS_TAB_FIRST_PAGE,
} from "@/components/tab-first-pages";

const nav = vi.hoisted(() => ({
  path: "/trends",
  search: "tab=nutrition&range=90d",
  followed: [] as string[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    replace: _,
    scroll: __,
    ...props
  }: ComponentPropsWithRef<"a"> & {
    href: string;
    replace?: boolean;
    scroll?: boolean;
  }) => {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          nav.followed.push(href);
        }}
      />
    );
  },
}));
beforeAll(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
);

describe("TabList", () => {
  it("owns button focus, selection, linkage, and mounted panels", () => {
    render(
      <TabList
        binding="button"
        ariaLabel="Import method"
        tabs={[
          { id: "upload", label: "File upload", content: <i>Upload</i> },
          { id: "paste", label: "Paste CSV", content: <i>Paste</i> },
        ]}
      />
    );
    const upload = screen.getByRole("tab", { name: "File upload" });
    const paste = screen.getByRole("tab", { name: "Paste CSV" });
    const uploadPanel = document.getElementById(
      upload.getAttribute("aria-controls")!
    )!;
    const pastePanel = document.getElementById(
      paste.getAttribute("aria-controls")!
    )!;
    expect([upload.getAttribute("aria-selected"), upload.tabIndex]).toEqual([
      "true",
      0,
    ]);
    expect(uploadPanel.getAttribute("aria-labelledby")).toBe(upload.id);
    expect([uploadPanel.hidden, pastePanel.hidden]).toEqual([false, true]);

    upload.focus();
    fireEvent.keyDown(upload, { key: "ArrowRight" });
    expect(document.activeElement).toBe(paste);
    expect([uploadPanel.hidden, pastePanel.hidden]).toEqual([true, false]);
    expect(screen.getByText("Upload")).not.toBeNull();
    expect(paste.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps query links current and follows arrow-key activation", () => {
    nav.path = "/trends";
    nav.search = "tab=nutrition&range=90d";
    nav.followed.length = 0;
    render(
      <>
        <TabList
          binding="link"
          ariaLabel="Trends sections"
          tabs={[
            { id: "body", label: "Body" },
            { id: "nutrition", label: "Nutrition" },
            { id: "insights", label: "Insights" },
          ]}
          panelId="trends-tabpanel"
          paramKey="tab"
        />
        <div id="trends-tabpanel" role="tabpanel" />
      </>
    );
    const nutrition = screen.getByRole("tab", { name: "Nutrition" });
    const insights = screen.getByRole("tab", { name: "Insights" });
    expect(nutrition.getAttribute("aria-current")).toBe("page");
    expect(insights.getAttribute("href")).toBe(
      "/trends?tab=insights&range=90d"
    );
    expect(insights.getAttribute("aria-controls")).toBe("trends-tabpanel");
    expect(document.getElementById("trends-tabpanel")).not.toBeNull();
    fireEvent.keyDown(nutrition, { key: "ArrowRight" });
    expect([document.activeElement, ...nav.followed]).toEqual([
      insights,
      "/trends?tab=insights&range=90d",
    ]);
  });

  it("renders real query and nested-route tab-first consumers", () => {
    nav.path = "/data";
    nav.search = "section=coverage";
    const view = render(<TabFirstTabs config={DATA_TAB_FIRST_PAGE} />);
    expect(
      screen.getByRole("tab", { name: "Coverage" }).getAttribute("aria-current")
    ).toBe("page");
    view.unmount();

    nav.path = "/records/history/visits";
    nav.search = "";
    render(<TabFirstTabs config={RECORDS_TAB_FIRST_PAGE} />);
    const history = screen.getByRole("tab", { name: "History" });
    expect([
      history.getAttribute("aria-selected"),
      history.getAttribute("href"),
    ]).toEqual(["true", "/records/history"]);
    expect(history.getAttribute("aria-controls")).toBe("records-tabpanel");
  });
});
