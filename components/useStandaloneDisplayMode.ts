"use client";

import { useMediaQuery } from "./useMediaQuery";

export function useStandaloneDisplayMode(): boolean {
  return useMediaQuery("standalone");
}
