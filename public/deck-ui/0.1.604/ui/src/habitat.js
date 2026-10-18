// UI client: credentials and transports belong to the host. Replay has no end marker;
// each current or changed state replaces the cached value by entity_id.
export function habitatClient(host) {
  const states = new Map();
  return {
    states,
    health: options => host.call('habitat.health', {}, options),
    settings: options => host.call('habitat.settings', {}, options),
    setting: (name, value, options) => host.call('habitat.setting', {query: {name}, body: {value}}, options),
    rules: options => host.call('habitat.rules', {}, options),
    shadowreport: (name, options) => host.call('habitat.shadowreport', {query: {rule: name, days: 7}}, options),
    rule: (name, mode, options) => host.call('habitat.rule', {query: {id: name}, body: {mode}}, options),
    entities: options => host.call('habitat.entities', {}, options),
    async read(options) {
      const values = await host.call('habitat.states', {}, options);
      for (const state of values) states.set(state.entity_id, state);
      return values;
    },
    state: (entity_id, options) => host.call('habitat.state', {query: {id: entity_id}}, options),
    subscribe(listener, {signal, patterns = ['light.*']} = {}) {
      const controller = new AbortController();
      const off = host.on('habitat.state', message => {
        if (message.new) states.set(message.entity_id, message.new);
        else states.delete(message.entity_id);
        listener(message, states);
      });
      const stop = () => { controller.abort(); off(); signal?.removeEventListener('abort', stop); };
      signal?.addEventListener('abort', stop, {once: true});
      if (signal?.aborted) stop();
      const ready = host.call('habitat.stream', {query: {patterns: patterns.join(',')}}, {signal: controller.signal});
      return {ready, unsubscribe: stop};
    },
  };
}
