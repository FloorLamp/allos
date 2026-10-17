// A host for tests and dev.mjs: records every call (`calls`: [{op, args}]), answers from `answers` (op → a value, or a function of
// args that returns or throws one), refuses args the contract does not allow (when given one) and ops whose cap is off (`refused`:
// why), and lets the test send events (`emit`). Resources map to `/fake/…`.
import {backendRoute} from './backends.js';
import {CAPS, SITE_CAPS, HOST_API, HostError, emitter, invalid, resourcePath} from './host.js';

export function fakeHost({kind = 'shell', caps = {}, answers = {}, contract = null, backends = {}, gesture = false, habitat = null} = {}) {
  const events = emitter();
  const host = {
    kind, hostApi: HOST_API,
    caps: {...Object.fromEntries(CAPS.map(c => [c, kind === 'shell' && !SITE_CAPS.includes(c)])), ...(kind === 'web' ? {projects: true, actions: true, clipboard: true, picks: true, browse: true, usage: true, corrections: true, texts: true, needs: true, money: true} : {}), ...caps},
    backends: Object.keys(backends), calls: [], refused: [],
    async call(op, args = {}, {signal} = {}) {
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
      const a = answers[op];
      const value = typeof a === 'function' ? await a(args, {signal}) : a;
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
