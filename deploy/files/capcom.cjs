// Runs inside the existing Allos container; stdin/stdout carry env only.
const fs = require("node:fs");
const Database = require("better-sqlite3");
const env = fs.readFileSync(0, "utf8");
const token = env.match(/^CAPCOM_API_KEY=(capcom_[^\r\n]+)$/m)?.[1];
if (!token) process.exit(1);
const base = "http://10.69.6.200:9817";
const values = {
  AI_BASE_URL: base,
  HEALTH_AI_MODEL: "default",
  AI_LOG_PROMPTS: "0",
};
const settings = {};
for (const [tier, model] of [
  ["heavy", "default"],
  ["light", "fast"],
]) {
  for (const [field, value] of Object.entries({
    shape: "anthropic",
    base_url: base,
    api_key: token,
    model,
  })) {
    settings[`ai_${tier}_${field}`] = value;
  }
}
const check = process.argv[1] === "check";
const db = new Database("/app/data/allos.db", {
  readonly: check,
  fileMustExist: true,
});
db.pragma("busy_timeout = 5000");
if (check) {
  const valid =
    !/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=/m.test(env) &&
    Object.entries(values).every(
      ([key, value]) =>
        env
          .split(/\r?\n/)
          .filter((line) => line.startsWith(`${key}=`))
          .join("\n") === `${key}=${value}`
    ) &&
    Object.entries(settings).every(
      ([key, value]) =>
        db.prepare("SELECT value FROM settings WHERE key = ?").get(key)
          ?.value === value
    );
  db.close();
  process.exit(valid ? 0 : 1);
}
db.transaction(() => {
  const put = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(settings)) put.run(key, value);
})();
db.close();
const cleaned = env
  .split(/\r?\n/)
  .filter(
    (line) =>
      !/^\s*(?:export\s+)?(?:ANTHROPIC_API_KEY|AI_BASE_URL|HEALTH_AI_MODEL|AI_LOG_PROMPTS)\s*=/.test(
        line
      )
  );
process.stdout.write(
  cleaned.join("\n") +
    "\n" +
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") +
    "\n"
);
