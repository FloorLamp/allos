// One Habitat reconnect lifecycle for native transports and the session-backed web socket.
export function habitatStream({openSocket, emit, random = Math.random, schedule = setTimeout, cancel = clearTimeout, headers, subscribe = true}) {
  let stop = () => {};
  return {
    open(route, args, signal) {
      stop();
      let socket, timer, stopped = false, attempt = 0;
      const url = new URL(route.url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      stop = () => { stopped = true; cancel(timer); signal?.removeEventListener('abort', unsubscribe); socket?.close(); };
      const unsubscribe = stop;
      signal?.addEventListener('abort', unsubscribe, {once: true});
      const retry = status => {
        if (stopped) return;
        emit('habitat.stream', {live: false, ...(status ? {status} : {})});
        if (status === 401 || status === 403) { unsubscribe(); return; }
        timer = schedule(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.5 + random() * 0.5));
      };
      const connect = () => {
        if (stopped) return;
        let ws;
        try { ws = socket = openSocket(url.href, {headers}); }
        catch (error) { retry(error.status); return; }
        ws.onopen = () => {
          if (stopped) return;
          if (subscribe) ws.send(JSON.stringify({subscribe: (args.query?.patterns ?? 'light.*').split(',')}));
          emit('habitat.stream', {live: true});
        };
        ws.onmessage = event => {
          if (stopped || socket !== ws) return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'state_changed' && typeof message.entity_id === 'string') {
            attempt = 0;
            emit('habitat.state', {entity_id: message.entity_id, new: message.new ?? null});
          }
        };
        ws.onclose = event => {
          if (stopped || socket !== ws) return;
          socket = null;
          retry(event?.status ?? ([4401, 4403].includes(event?.code) ? event.code - 4000 : undefined));
        };
        ws.onerror = event => { if (event?.status === 401 || event?.status === 403) retry(event.status); };
      };
      if (!signal?.aborted) connect();
      return {};
    },
    close() { stop(); },
  };
}
