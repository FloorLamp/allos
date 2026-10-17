// Shared by the Accounts route and middleware's early authentication response.
export function accountsCors(req: Request, headers: Headers): void {
  headers.append("Vary", "Origin");
  const origin = process.env.DECK_ORIGIN;
  if (origin && req.headers.get("origin") === origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
}
