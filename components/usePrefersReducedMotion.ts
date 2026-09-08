"use client";

import { useMediaQuery } from "./useMediaQuery";

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("reducedMotion");
}
