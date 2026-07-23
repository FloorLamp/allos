import {
  parseOnboardingState,
  serializeOnboardingState,
  type OnboardingState,
} from "../onboarding";
import { getProfileSetting, setProfileSetting } from "./kv";

export const ONBOARDING_STATE_KEY = "onboarding_state";

export function getOnboardingState(profileId: number): OnboardingState | null {
  return parseOnboardingState(
    getProfileSetting(profileId, ONBOARDING_STATE_KEY)
  );
}

export function setOnboardingState(
  profileId: number,
  state: OnboardingState
): void {
  setProfileSetting(
    profileId,
    ONBOARDING_STATE_KEY,
    serializeOnboardingState(state)
  );
}
