// Recover configuration from the running release, never from public defaults.
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const input = fs.readFileSync(0, "utf8");
const env = parseEnv(input);
const keys = [
  "DECK_ORIGIN",
  "CAPCOM_URL",
  "DECK_UI_CHANNEL",
  "ALLOWED_DEV_ORIGINS",
];
if (process.argv[1] === "check") {
  process.exit(keys.every((key) => env[key]) ? 0 : 1);
}
const missing = keys.filter((key) => !env[key]);
if (!missing.length) {
  process.stdout.write(input);
  process.exit(0);
}
const recovered = {
  DECK_ORIGIN: env.ALLOS_DECK_ORIGIN,
  CAPCOM_URL: env.AI_BASE_URL,
  DECK_UI_CHANNEL: process.env.DECK_UI_CHANNEL,
};
const server = fs.readFileSync("/app/server.js", "utf8");
const config = JSON.parse(server.match(/const nextConfig = (.+)\r?\n/)[1]);
recovered.ALLOWED_DEV_ORIGINS = config.allowedDevOrigins?.join(",");
if (!recovered.DECK_ORIGIN) {
  for (const version of fs.readdirSync("/app/public/deck-ui")) {
    const file = path.join(
      "/app/public/deck-ui",
      version,
      "ui/contract/places.json"
    );
    const places = JSON.parse(fs.readFileSync(file, "utf8"));
    const search = places.find((place) => place.id === "search");
    if (search) recovered.DECK_ORIGIN = new URL(search.href).origin;
  }
}
for (const key of missing) {
  if (!recovered[key] || /[\r\n]/.test(recovered[key])) {
    throw new Error(`Cannot recover ${key} from the running release`);
  }
}
// Replace empty assignments too; preserve all unrelated settings verbatim.
const lines = input
  .split(/\r?\n/)
  .filter(
    (line) =>
      !missing.some((key) =>
        new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line)
      )
  );
process.stdout.write(
  lines.join("\n") +
    "\n" +
    missing
      .map((key) => `${key}=${JSON.stringify(recovered[key])}`)
      .join("\n") +
    "\n"
);
