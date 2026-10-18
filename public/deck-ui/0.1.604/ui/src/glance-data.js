// Pure Tower payload readers shared by the CLI popover and phone landing.
/** Tower's plans.json rows (one per agent, account and window) grouped per agent and account, in Tower's order (tightest last
 *  per agent): [{agent, account, name (the email's local part), windows: [{window, percent, resetsAt, severity, rate, fullAt}]}]. */
export function planGroups(plans) {
  const groups = new Map();
  for (const p of plans?.plans ?? []) {
    const key = `${p.agent}\n${p.account}`;
    if (!groups.has(key)) groups.set(key, {agent: p.agent, account: p.account, name: String(p.account ?? '').split('@')[0], windows: []});
    groups.get(key).windows.push({window: p.window, percent: p.percent ?? null, resetsAt: p.resetsAt ?? null, severity: p.severity ?? null,
      rate: p.rate ?? null, fullAt: p.fullAt ?? null});
  }
  return [...groups.values()];
}

/** The fleet as the popover draws it (Tower's board's machines): each worker's state, its slots (each running job's weight in its
 *  priority, then `free`, the reserved ones `reserve`), its load per core now and by hour (Sortie's `loadHours`: the last 24, oldest
 *  first). */
export function fleetStatus(status) {
  return status.workers.map(w => {
    const online = w.online ?? w.state === 'online', reserve = Number(w.info?.reserve ?? 0);
    const slots = (status.running ?? []).filter(j => (w.running ?? []).includes(j.id)).flatMap(j => Array(j.weight ?? 1).fill(j.priority ?? 'background'));
    for (let i = slots.length; i < w.capacity; i++) slots.push(i >= w.capacity - reserve ? 'reserve' : 'free');
    return {name: w.name, state: online && w.drained ? 'drained' : w.state, intermittent: !!w.intermittent, why: w.info?.why ?? null, slots,
      loadPerCore: w.info?.load?.perCore ?? null, loadHours: w.loadHours ?? []};
  });
}

