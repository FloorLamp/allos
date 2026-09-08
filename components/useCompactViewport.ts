"use client";

import { useMediaQuery } from "./useMediaQuery";

export function useCompactViewport(): boolean {
  return useMediaQuery("maxMd");
}
