import { GET as accounts } from "@/app/v1/accounts/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The session twin of /v1/accounts (docs/device-api.md, *Web twins*), readable from
// Deck's Accounts place on its own origin (deck-ui's web host: a credentialed GET,
// no preflight; deck.wang.team is same-site, so the Lax session cookie rides along).
// Exactly that origin, never a reflected one, on every answer this route gives
// (a request with no session cookie at all is middleware's 401 and carries none).
const DECK_ORIGIN = process.env.ALLOS_DECK_ORIGIN || "https://deck.wang.team";

export async function GET(req: Request): Promise<Response> {
  const res = await accounts(req);
  const headers = new Headers(res.headers);
  headers.append("Vary", "Origin");
  if (req.headers.get("origin") === DECK_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", DECK_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return new Response(res.body, { status: res.status, headers });
}
