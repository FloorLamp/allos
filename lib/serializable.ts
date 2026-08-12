// THE SERVER ACTION SERIALIZATION BOUNDARY (#2149 item 3).
//
// "Server Action records pass serializable data only. Do not return a
// `better-sqlite3` row proxy to a client component." (AGENTS.md) — a stated
// invariant with no guard at any tier: no scan, no type, only review.
//
// What goes wrong when it slips is not a type error at the call site. React
// serializes an action's resolved value to send it back to the browser, and a
// value it cannot serialize throws AT RUNTIME, in production, on whichever
// branch of the action happened to produce it — a `Statement`, a class
// instance, a callback smuggled inside an options object, a lazily-computed
// getter. The action's own module compiles perfectly.
//
// `Serializable<T>` is that guard as a TYPE. It is a structural mirror of what
// React's serializer accepts, so the rejection happens where the value is
// SHAPED rather than where it is sent.
//
// Two things it deliberately is not:
//
//   • It is not a runtime check. The action boundary is hot and every value
//     crossing it is already walked by React; walking it twice to say what the
//     types can say for free is the wrong trade.
//   • It is not a claim about PHI, about authorization, or about whether the
//     value is one a client SHOULD see. It is only about whether the value can
//     survive the trip.

/** Values React sends across the boundary as themselves. */
type SerializablePrimitive =
  string | number | boolean | bigint | null | undefined;

/**
 * True only for `unknown` / `any` — the two types that state nothing about a
 * value's shape. Neither is EVIDENCE of an unserializable value, so neither is
 * rejected; a reviewer reading an action typed `unknown` learns nothing from a
 * type error there.
 */
type IsUnknownOrAny<T> = unknown extends T ? true : false;

/**
 * The serializable projection of `T`: every part React can carry, preserved;
 * every part it cannot, mapped to `never` so the original no longer assigns to
 * it. Functions are the load-bearing case — a class instance is rejected
 * BECAUSE its prototype methods are functions, which is also why a plain object
 * carrying a callback is rejected in the same breath.
 */
export type Serializable<T> =
  IsUnknownOrAny<T> extends true
    ? T
    : [T] extends [never]
      ? T
      : T extends SerializablePrimitive
        ? T
        : T extends void
          ? T
          : T extends symbol
            ? never
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              T extends (...args: any[]) => unknown
              ? never
              : T extends Date | RegExp | Error | URL
                ? T
                : T extends Promise<infer V>
                  ? Promise<Serializable<V>>
                  : T extends ReadonlyMap<infer K, infer V>
                    ? ReadonlyMap<Serializable<K>, Serializable<V>>
                    : T extends ReadonlySet<infer E>
                      ? ReadonlySet<Serializable<E>>
                      : T extends ArrayBufferView | ArrayBuffer
                        ? T
                        : T extends readonly (infer E)[]
                          ? { [I in keyof T]: Serializable<T[I]> }
                          : T extends object
                            ? { [K in keyof T]: Serializable<T[K]> }
                            : never;

declare const NOT_SERIALIZABLE: unique symbol;

/**
 * The failure value. It is a nominal type nothing assigns to, so a rejected
 * return type fails at the DECLARATION rather than somewhere downstream, and
 * the compiler names the offending action in the error.
 */
export interface NotSerializable<Why extends string> {
  readonly [NOT_SERIALIZABLE]: Why;
}

/**
 * `T` when `T` survives the boundary, and an unassignable marker when it does
 * not. Used as `satisfies` / an explicit annotation on an action's return type,
 * and as the census assertion in
 * `lib/__tests__/serializable-action-returns.test.ts`.
 */
export type AssertSerializable<T> = [T] extends [Serializable<T>]
  ? T
  : NotSerializable<"this value cannot cross the Server Action boundary">;

/**
 * One `"use server"` module rewritten so that every action's resolved value has
 * passed through `AssertSerializable`. A non-action export is carried through
 * untouched — a `"use server"` module that exports a non-async value is a
 * different defect and not this type's business.
 *
 * The module only assigns back to its own rewrite when every action survives,
 * which is what turns the assertion into a real check rather than a type alias
 * that quietly resolves to a marker nobody reads.
 */
export type SerializableActions<M> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof M]: M[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<AssertSerializable<R>>
    : M[K];
};

/**
 * `true` when every action a module exports returns something that can cross
 * the boundary, `false` otherwise. Asserted as a census in
 * `lib/__tests__/serializable-action-returns.test.ts`, where a `false` names
 * the offending module in the compiler's own error.
 */
export type ActionsAreSerializable<M> =
  M extends SerializableActions<M> ? true : false;
