import {
  ONBOARDING_VERSION,
  parseOnboardingState,
  serializeOnboardingState,
  type OnboardingState,
} from "../onboarding";
import {
  getLoginSetting,
  getProfileSetting,
  setLoginSetting,
  setProfileSetting,
} from "./kv";

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

function orientationKey(profileId: number): string {
  return `profile_orientation_v${ONBOARDING_VERSION}:${profileId}`;
}

export function isProfileOrientationDismissed(
  loginId: number,
  profileId: number
): boolean {
  return getLoginSetting(loginId, orientationKey(profileId)) === "dismissed";
}

export function dismissProfileOrientation(
  loginId: number,
  profileId: number
): void {
  setLoginSetting(loginId, orientationKey(profileId), "dismissed");
}
