import {maskedIdentifier} from './identifiers.js';

// Shared presentation rules for list projections and already-loaded collection details.
export const policyProjection = policy => ({...policy, number: policy.number ? maskedIdentifier(policy.number) : undefined});
export const paperProjection = (paper, state = paper.state) => ({...paper, number: paper.number ? maskedIdentifier(paper.number) : undefined,
  scope: paper.scope && /\d/.test(paper.scope) ? maskedIdentifier(paper.scope) : paper.scope, state});
