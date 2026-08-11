// Shared by action tests that exercise a real password-strength or sign-in path.
// Keep this visibly fake and low-entropy so neither a reader nor a secret scanner
// could mistake it for a credential. It still clears checkPasswordStrength(): it
// is longer than the minimum and contains lowercase, digit, and symbol classes.
export const ACTION_TEST_PASSWORD = "not-a-real-password-1";
