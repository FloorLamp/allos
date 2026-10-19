import {habitatActions} from '../house-actions.js';
import {HostError, invalid} from './host.js';

// A control catalog from entities/states, never Habitat's GET /v1/actions audit log.
export function houseActionOps(call) {
  let listed = [];
  return async (op, args = {}, options) => {
    const why = invalid({type: 'object', additionalProperties: false,
      properties: op === 'habitat.run' ? {id: {type: 'string', maxLength: 300}} : {},
      ...(op === 'habitat.run' ? {required: ['id']} : {})}, args);
    if (why) throw new HostError('refused', why);
    if (op === 'habitat.actions') {
      listed = [];
      const [entities, states] = await Promise.all([call('habitat.entities', {}, options), call('habitat.states', {}, options)]);
      listed = habitatActions(entities, states);
      return {actions: listed.map(({entity, request, ...row}) => row)};
    }
    const action = listed.find(a => a.id === args.id);
    if (!action) throw new HostError('refused', 'Action is not in the last Habitat list');
    // The host's raw write op enforces the gesture. Dispatch once; a timeout can mean partial execution.
    const result = await call('habitat.act', {body: action.request}, options);
    if (result?.ok !== true) throw new HostError('http', result?.error ?? 'Action failed');
    const state = result.shadow ? null : await call('habitat.state', {query: {id: action.entity}}, options).catch(() => null);
    return {...result, title: action.title, state: result.shadow ? 'recorded in shadow' : state?.state ?? null};
  };
}
