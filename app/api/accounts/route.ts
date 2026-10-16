import { GET as accounts } from "@/app/v1/accounts/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The session twin of /v1/accounts (docs/device-api.md, *Web twins*), readable from
// Deck's Accounts place on its own origin (deck-ui's web host: a credentialed GET,
// no preflight; a same-site deployment carries the Lax session cookie).
// Exactly that origin, never a reflected one, on every answer this route gives
// (a request with no session cookie at all is middleware's 401 and carries none).
export async function GET(req: Request): Promise<Response> {
  const res = await accounts(req);
  const origin = process.env.DECK_ORIGIN;
  const headers = new Headers(res.headers);
  headers.append("Vary", "Origin");
  if (req.headers.get("origin") === origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return new Response(res.body, { status: res.status, headers });
}
