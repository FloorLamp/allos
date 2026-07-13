// Standalone `tsx` entrypoints do not get Next.js's automatic .env loading.
// Keep that setup in its own FIRST-imported module: ESM evaluates dependencies
// before an entrypoint's body, so calling loadEnvConfig inline above a static
// `lib/db` import is still too late — db.ts has already booted by then.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
