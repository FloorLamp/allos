// Run every owned-resource cleanup step even when an earlier artifact step
// fails. The first failure still reaches the caller after teardown completes.
export async function runCleanupSteps(steps, report = console.error) {
  let firstError = null;
  for (const [label, operation] of steps) {
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
      report(`cleanup failed (${label}):`, error);
    }
  }
  if (firstError) throw firstError;
}
