// Deep-link resolution for the combined "Log measurements" form (issue #1486).
//
// Two param conventions reach this form, and they used to reach three different
// forms on two different tabs:
//   • `focus=` — the care surfaces' convention (the preventive blood-pressure nudge
//     `focus=blood-pressure` (#1083), the sleep prompt `focus=sleep` (#800), the
//     pediatric-height data-quality CTA `focus=height` (#1146));
//   • `new=`   — the command palette's FOCUS_PARAM (`new=weight` / `new=vitals`, #29).
// After the merge both land on ONE form, so the mapping is one pure table here —
// shared by the form (which field to focus) and by the desktop expander / mobile
// overlay (whether to open at all). An unrecognized value focuses nothing, so a
// stale or crafted link never plants a surprise cursor.

export function deepLinkFieldId(
  focus: string | null | undefined,
  created: string | null | undefined
): string | null {
  switch (focus) {
    case "blood-pressure":
      return "m-systolic";
    case "sleep":
      return "m-sleep";
    case "height":
      return "m-height";
    case "weight":
      return "m-weight";
  }
  switch (created) {
    case "weight":
      return "m-weight";
    case "vitals":
      // The palette's "Log vitals" action (keywords: resting, hr, heart, body fat)
      // has always focused the resting-HR field; the merge keeps that target.
      return "m-resting-hr";
  }
  return null;
}

// Whether a URL asks the measurements form to OPEN: the desktop expander starts
// collapsed, and the phone carries no on-page form at all (the quick-entry overlay
// is its logging path), so a deep link has to say "open me" as well as "focus this".
export function measurementsDeepLinked(
  focus: string | null | undefined,
  created: string | null | undefined
): boolean {
  return deepLinkFieldId(focus, created) != null;
}
