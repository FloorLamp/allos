import "server-only";

import { cache } from "react";

// One wall-clock snapshot per Server Component render. React clears `cache()`
// between server requests, while every reader participating in one render sees the
// same value. This keeps expiry and elapsed-time decisions idempotent within the
// render without routing duration semantics through the date-derivation test clock.
export const requestNowMs = cache(() => Date.now());
