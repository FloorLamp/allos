// The marker an Upcoming row carries so a dismissal from its kebab can find the
// element to slide toward the fold (#2654, motion 2).
//
// Its own module, with NO "use client", on purpose. The row is a Server Component and
// the menu is a client one, so the name has to be readable from both — and a plain
// constant exported from a `"use client"` module is NOT readable from the server side:
// the import resolves to a client-reference proxy, so the attribute renders under a
// garbage name and the `closest()` lookup silently finds nothing. That is exactly how
// this shipped broken once; keep the string here.
export const DISMISS_ROW_ATTR = "data-dismiss-row";
