"use client";

import { createContext, useCallback, useContext } from "react";
import { LOGGED_VIA_FIELD, type WebLoggedVia } from "@/lib/logged-via";

// WHICH SURFACE THIS SUBTREE IS (#3087) — the mechanism behind "each mounting declares
// itself", and the reason it is a CONTEXT rather than a prop on every control.
//
// THE PROBLEM. The server cannot tell the dashboard's food bar from the quick-log
// sheet's food bar from the Food page's food bar: they are three mountings of ONE
// component posting ONE Server Action, and the request looks identical from all three.
// `parseWebOrigin` therefore reads the surface off the post — and if nothing posts it,
// every mounting silently takes the action's own `page` fallback. Wiring three
// components by hand left seventeen read sites answering `page` for surfaces that were
// not pages, which is the failure this replaces.
//
// WHY A CONTEXT AND NOT A PROP. A prop has to be threaded through every intermediate —
// the sheet's body switch, the dashboard's card wrappers, the illness cockpit's panels —
// and each hop is somewhere to forget. The surfaces, meanwhile, are REGIONS: everything
// rendered inside the quick-log sheet is the quick-log sheet, whatever it is. Declaring
// the region once at its root is the same shape `FoodSelectedDateProvider` already uses
// for the selected day, and it means a control moved into a new region reports the new
// region without being edited at all.
//
// THE DEFAULT IS `page`, AND IT IS AN ANSWER RATHER THAN A FALLBACK. A control rendered
// by a domain page, with no surface declared above it, IS on that page's own form. That
// is the same value `parseWebOrigin`'s callers pass as their fallback, so the two agree
// by construction — the context does not invent a surface where none was declared, it
// states the one the page already is.
//
// NOT A SUBSTITUTE FOR THE SERVER'S PARSE. This value rides the post, so it is
// attacker-controlled like any other field; `parseWebOrigin` still refuses anything
// outside the four web surfaces, which is what keeps a forged post from dressing a web
// tap up as a Telegram tap, an import or an offline replay.
const SurfaceContext = createContext<WebLoggedVia>("page");

/**
 * Declare the surface every control inside this subtree is mounted on.
 *
 * Mount it at a REGION ROOT — the quick-log sheet's body, the command palette, a
 * dashboard widget — never around an individual button, which is what a prop is for.
 */
export function LoggedViaSurface({
  value,
  children,
}: {
  value: WebLoggedVia;
  children: React.ReactNode;
}) {
  return (
    <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>
  );
}

/** The surface the calling control is mounted on. `page` when nothing declared one. */
export function useLoggedVia(): WebLoggedVia {
  return useContext(SurfaceContext);
}

/**
 * Stamp a FormData with the surface it is about to be posted from.
 *
 * The hook form (rather than a bare function taking the surface) is what keeps the
 * declaration and the post in one place: a control that builds its own FormData calls
 * this and cannot then forget which mounting it is in.
 */
export function useLoggedViaStamp(): (formData: FormData) => FormData {
  const surface = useLoggedVia();
  return useCallback(
    (formData: FormData) => {
      formData.set(LOGGED_VIA_FIELD, surface);
      return formData;
    },
    [surface]
  );
}

/**
 * The same declaration for a plain `<form action={…}>`, which builds its own FormData
 * from the DOM and never passes through a callback.
 */
export function LoggedViaField() {
  const surface = useLoggedVia();
  return <input type="hidden" name={LOGGED_VIA_FIELD} value={surface} />;
}
