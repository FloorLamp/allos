import { deckHealthHtml, deckUiCsp, ownerOnly } from "@/lib/deck-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deck's Health place on allos's own origin (additive: allos's own pages stay).
export const GET = (): Promise<Response> =>
  ownerOnly(deckHealthHtml, "text/html; charset=utf-8", deckUiCsp);
