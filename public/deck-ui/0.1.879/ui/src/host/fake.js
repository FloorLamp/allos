// A host for tests and dev.mjs (`member`: who the page was served to, member.js): records every call (`calls`: [{op, args}]), answers from `answers` (op → a value, or a function of
// args (and `{signal, onWarming}`) that returns or throws one), refuses args the contract does not allow (when given one) and ops whose cap is off (`refused`:
// why), and lets the test send events (`emit`). Resources map to `/fake/…`.
import {backendRoute} from './backends.js';
import {CAPS, SITE_CAPS, HOST_API, HostError, emitter, invalid, resourcePath} from './host.js';

export function fakeHost({kind = 'shell', caps = {}, answers = {}, contract = null, backends = {}, gesture = false, habitat = null, member = undefined} = {}) {
  const events = emitter();
  const host = {
    kind, hostApi: HOST_API, member,
    caps: {...Object.fromEntries(CAPS.map(c => [c, kind === 'shell' && !SITE_CAPS.includes(c)])), ...(kind === 'web' ? {clusters: true, actions: true, clipboard: true, picks: true, browse: true, usage: true, corrections: true, texts: true, needs: true, money: true, ranking: true, expiring: true, obligations: true} : {}), ...caps},
    backends: Object.keys(backends), calls: [], refused: [],
    async call(op, args = {}, {signal, onWarming} = {}) {
      host.calls.push({op, args});
      if (signal?.aborted) throw new HostError('cancelled');
      if (contract) {
        if (!contract.ops[op] && Object.hasOwn(backends, op.split('.')[0])) backendRoute(backends, op, args, {web: kind === 'web', gesture});
        const spec = contract.ops[op] ?? (Object.hasOwn(backends, op.split('.')[0]) ? contract.backendOp : null);
        const why = !spec ? `${op}: no such op` : spec.cap && !host.caps[spec.cap] ? `${op}: no ${spec.cap} here` : invalid(spec.args, args);
        if (why) {
          host.refused.push(spec ? `${op}: ${why}` : why);
          throw new HostError(spec && !(spec.cap && !host.caps[spec.cap]) ? 'refused' : 'unsupported', why);
        }
      }
      if (habitat && op.startsWith('habitat.')) return habitat.call(op, args, {signal});
      // a fake house has no ranking unless answered: its top is the whole list, as a host's with too little history
      const a = answers[op] ?? (op === 'habitat.top' ? answers['habitat.actions'] : undefined);
      const value = typeof a === 'function' ? await a(args, {signal, onWarming}) : a;
      if (signal?.aborted) throw new HostError('cancelled');
      return value ?? null;
    },
    resource(path) {
      if (!resourcePath(path, {shell: kind === 'shell'})) throw new HostError('refused', 'not a resource path');
      return `/fake${path}`;
    },
    on: events.on,
    emit: events.emit,
    notes: [],
    note(name, data) { host.notes.push({name, data}); },
  };
  return host;
}
