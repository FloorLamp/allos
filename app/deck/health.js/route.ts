import { deckHealthScript, ownerOnly } from "@/lib/deck-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Health place's one module (the page runs under script-src 'self').
export const GET = (): Promise<Response> =>
  ownerOnly(deckHealthScript, "text/javascript; charset=utf-8");
