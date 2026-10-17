import { GET as accounts } from "@/app/v1/accounts/route";
import { accountsCors } from "@/lib/accounts-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The session twin of /v1/accounts (docs/device-api.md, *Web twins*), readable from
// Deck's Accounts place on its own origin (deck-ui's web host: a credentialed GET,
// no preflight; a same-site deployment carries the Lax session cookie).
// Middleware uses the same policy for a request with no session cookie.
export async function GET(req: Request): Promise<Response> {
  const res = await accounts(req);
  const headers = new Headers(res.headers);
  accountsCors(req, headers);
  return new Response(res.body, { status: res.status, headers });
}
