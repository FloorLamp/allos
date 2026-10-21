import {habitatActions} from '../house-actions.js';
import {HostError, invalid} from './host.js';

// A control catalog from entities/states, never Habitat's GET /v1/actions audit log.
export function houseActionOps(call) {
  let listed = [];
  return async (op, args = {}, options) => {
    const why = invalid({type: 'object', additionalProperties: false,
      properties: op === 'habitat.run' ? {id: {type: 'string', maxLength: 300}} : op === 'habitat.top' ? {limit: {type: 'integer', minimum: 1, maximum: 20}} : {},
      ...(op === 'habitat.run' ? {required: ['id']} : op === 'habitat.top' ? {required: ['limit']} : {})}, args);
    if (why) throw new HostError('refused', why);
    if (op === 'habitat.top') {
      // the landing's tiles: Habitat's most used, each with its entity and state; too little history, the whole list below
      const usage = await call('habitat.usage', {query: {limit: args.limit}}, options).catch(() => null);
      if (usage?.ranked?.length >= args.limit) {
        const order = new Map(usage.ranked.map((r, i) => [r.entity_id, i]));
        const seen = new Set();
        listed = habitatActions(usage.entities ?? [], usage.states ?? []).sort((a, b) => order.get(a.entity) - order.get(b.entity))
          .filter(a => !seen.has(a.entity) && seen.add(a.entity)).slice(0, args.limit);
        return {actions: listed.map(({entity, request, ...row}) => row), total: usage.controllable ?? listed.length, partial: true};
      }
    }
    if (op === 'habitat.actions' || op === 'habitat.top') {
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
