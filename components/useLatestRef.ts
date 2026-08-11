"use client";

import { useLayoutEffect, useRef } from "react";

// Keep the latest COMMITTED value available to long-lived event handlers without
// reading or mutating a ref during render. Layout timing is deliberate: a browser
// event cannot observe the previous value after React has committed the new view.
export function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
