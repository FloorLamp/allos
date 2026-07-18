// SERVER-ACTION TIER — the date/time display preferences (issue #964).
//
// Two login-tier prefs (time_format, date_format), the siblings of the unit prefs,
// persist through the login-settings action under its requireSession() gate and are
// read back through getDisplayFormatPrefs. Unknown/garbage values fall back to the
// status-quo default server-side, so a hand-crafted post can't store a nonsense
// format. The DB is real (a throwaway temp DB), so each test asserts the actual
// login_settings rows the action wrote.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveDisplayFormatPrefs } from "@/app/(app)/settings/actions";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("saveDisplayFormatPrefs persists the login's date/time prefs (#964)", () => {
  it("stores the chosen clock and date shape and revalidates the layout", async () => {
    const login = createLogin();
    const profile = createProfile("fmt-1", login.id);
    actAs(login, profile);

    await saveDisplayFormatPrefs(
      fd({ time_format: "12h", date_format: "iso" })
    );

    expect(getDisplayFormatPrefs(login.id)).toEqual({
      timeFormat: "12h",
      dateFormat: "iso",
    });
    expect(revalidate).toHaveBeenCalledWith("/", "layout");
  });

  it("keys prefs to the acting login, not the profile", async () => {
    const a = createLogin();
    const b = createLogin();
    const pa = createProfile("fmt-a", a.id);
    const pb = createProfile("fmt-b", b.id);

    actAs(a, pa);
    await saveDisplayFormatPrefs(
      fd({ time_format: "12h", date_format: "dmy" })
    );
    actAs(b, pb);
    await saveDisplayFormatPrefs(
      fd({ time_format: "24h", date_format: "mdy" })
    );

    expect(getDisplayFormatPrefs(a.id)).toEqual({
      timeFormat: "12h",
      dateFormat: "dmy",
    });
    expect(getDisplayFormatPrefs(b.id)).toEqual({
      timeFormat: "24h",
      dateFormat: "mdy",
    });
  });

  it("falls back to the status-quo default for unknown values", async () => {
    const login = createLogin();
    const profile = createProfile("fmt-bad", login.id);
    actAs(login, profile);

    await saveDisplayFormatPrefs(
      fd({ time_format: "banana", date_format: "yyyy" })
    );

    expect(getDisplayFormatPrefs(login.id)).toEqual({
      timeFormat: "24h",
      dateFormat: "mdy",
    });
  });
});
