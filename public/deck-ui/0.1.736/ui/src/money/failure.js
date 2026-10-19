import {describeFailure} from '../failure.js';

// Only locally constructed validation feedback is safe to show verbatim.
export class MoneyValidationError extends Error {}

export function moneyFailure(error, task) {
  if (error instanceof MoneyValidationError) return error.message;
  return `Could not ${task}. ${describeFailure('purser', error).message}`;
}
