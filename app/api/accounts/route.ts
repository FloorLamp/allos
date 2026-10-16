import { GET as accounts } from "@/app/v1/accounts/route";

export async function GET(req: Request): Promise<Response> {
  const response = await accounts(req);
  response.headers.append("Vary", "Origin");
  const origin = process.env.ALLOS_DECK_ORIGIN ?? "https://deck.wang.team";
  if (req.headers.get("origin") === origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
