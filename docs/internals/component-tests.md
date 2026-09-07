# Component tests

Use this tier for behavior that needs a mounted hook or DOM: event handling,
focus, browser state, and client-side error feedback. Domain calculations belong
in `lib/` and its pure tests. A real page or Server/Client integration belongs in
E2E only when a cheaper tier cannot observe the failure.

The `components` project in `vitest.config.ts` runs jsdom and
`@testing-library/react` under `npm test`. There is no separate CI job or command.

## Write a focused test

- Put `*.test.ts` or `*.test.tsx` in `components/__tests__/`.
- Extend an existing subject's tests before creating another file.
- Use `render`, `renderHook`, and `act` from the existing testing library.
- `components/__tests__/setup.ts` unmounts, clears the document, and clears
  storage. Reset any additional module-level state your test changes.
- Assert the outcome people rely on, such as kept input after a failed save,
  rather than the component's internal implementation.
- Exercise rejected promises and returned errors when the client treats them
  differently. Use tables for cases with identical setup and assertions.
- Before asserting absence, let the operation settle. A positive control should
  demonstrate that the harness can reach the effect being suppressed.
- Freeze the clock when behavior depends on current time, and restore it in
  cleanup. A DOM test can still depend on profile-local time and deadlines.
- If a production source scan reads a test fixture as app code, fix its discovery
  scope; do not distort the fixture to evade the scan.

Useful examples: `dirty-form-registry.test.ts` for document reads,
`auto-update-reload.test.ts` for an asynchronous reload decision, and
`imported-name-offer.test.tsx` for client interaction/error feedback. These are
examples to consult, not a required pattern for every test.

Run a file with `npm test -- components/__tests__/name.test.tsx`. Apply the
[shared test-value rules](../change-policy.md) before adding coverage.
