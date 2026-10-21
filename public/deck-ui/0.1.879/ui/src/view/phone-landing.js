// The approved phone composition of the same sections as the desktop popover and palette: Codes, what is due (Due soon), then Needs you.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useReducer, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPhoneLanding} from '../phone-landing.js';
import {dueText} from '../flightplan.js';
import {Codes} from './sections/codes.js';
import {Needs} from './sections/needs.js';
import {Today} from './sections/today.js';
import {Recent} from './sections/recent.js';
import {House} from './sections/house.js';
import {LandingProjects} from './sections/projects.js';
import {DueSoon} from './sections/due-soon.js';
import {Asks} from './sections/asks.js';
import {Plans} from './sections/plans.js';
import {Fleet} from './sections/fleet.js';
import {Row} from './sections/row.js';
import {siteUrl, todoPath} from '../flightplan-paths.js';
const html = htm.bind(h);
const TOWER = 'https://spaceport.wang.team';
const TODO = siteUrl(todoPath());

export function PhoneLanding({c, rows, renderRow, fold, needsState = null, houseState = null, asks = [], onAsk}) {
  const host = c.host;
  const [model] = useState(() => createPhoneLanding(host));
  const [, redraw] = useReducer(n => n + 1, 0);
  useEffect(() => {
    const off = model.subscribe(redraw);
    const refresh = () => { if (!document.hidden) model.refresh(); };
    const onShow = host.on('show', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 60000);
    refresh();
    return () => { off(); onShow(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); model.stop(); };
  }, [model, host]);
  // The web host learns the owner's Tower access with env.get, after the first read.
  const tower = !!host.caps.tower;
  useEffect(() => { if (tower) model.refresh(); }, [model, tower]);
  const open = url => {
    if (host.kind === 'web' && new URL(url, location.href).origin === location.origin) location.assign(url);
    else host.call('url.open', {url}).catch(() => {});
  };
  const recent = rows.filter(r => r.kind === 'recent'), house = rows.filter(r => r.kind === 'action'), needs = rows.filter(r => r.kind === 'need');
  // Keyboard selection may reveal another Recent row; ordinary opens stay within the phone's length budget.
  const recentLimit = Math.max(2, recent.findIndex(r => r.id === c.view().selected) + 1);
  const recentTotal = Math.max(recent.length, c.sectionMore('recent'));
  // Needs you: three (a selected one further down shows too), then All n on Todo (its Needs you first); only the first question's options inline
  const needsLimit = Math.max(3, needs.findIndex(r => r.id === c.view().selected) + 1);
  const answering = needs.slice(0, needsLimit).find(r => r.need.item?.question?.options?.length)?.id;
  return html`<div class="dp-phone-landing dg" aria-label="Deck overview">
    <${Codes} rows=${rows.filter(r => r.kind === 'code')} renderRow=${renderRow} fold=${fold} />
    <${DueSoon} host=${host} idle=${true} fold=${fold} onOpen=${id => c.viewRef(id)} />
    <${Needs} rows=${needs} fold=${fold} state=${needsState} limit=${needsLimit} onMore=${() => open(TODO)} renderRow=${row => html`<div class="dp-phone-need">
      ${renderRow(row)}
      ${row.id === answering ? html`<div class="dp-need-answers df-question-choices" role="group" aria-label=${`Answer: ${row.need.item.question.text}`}>
        ${row.need.item.question.options.map(option => html`<button type="button" class="dk-btn df-choice" disabled=${c.needAnswering(row.need.item.id)}
          onClick=${() => c.answerNeed(row.need.item, option)}>${option}</button>`)}
      </div>` : null}
    </div>`} />
    ${host.backends?.includes('flightplan') ? html`<${Today} rows=${model.today} fold=${fold} limit=${3}
      empty="Nothing due today." loading=${model.loading} error=${model.errors.today} retry=${() => model.refresh()} host=${host} onMore=${() => open(TODO)}
      renderRow=${item => html`<${Row} kind="todo" row=${{text: item.title, url: siteUrl(todoPath({id: item.id})),
        sub: item.due ? `${item.due.slice(0, 10) < model.date ? 'Overdue · ' : ''}${dueText(item.due, model.date)}` : 'Today',
        tone: item.due && item.due.slice(0, 10) < model.date ? 'warn' : 'live'}} onOpen=${open} />`} />` : null}
    ${host.backends?.includes('flightplan') ? html`<${LandingProjects} host=${host} platform=${c.platform?.platform} idle=${true} quiet=${false} fold=${fold} />` : null}
    <${Recent} rows=${recent} renderRow=${renderRow} fold=${fold} limit=${recentLimit} more=${recentTotal - recent.length}
      empty="Nothing recent yet." onMore=${() => recent[0] && c.openGroupOf(recent[0].id)} onClear=${host.caps.recent && recent.length ? () => c.clearRecent() : null} />
    <${House} rows=${house} renderRow=${renderRow} fold=${fold} limit=${4} total=${c.houseTotal()} state=${houseState}
      empty=${html`<${Row} kind="house" row=${{text: 'House', sub: 'Rooms, cameras and controls', url: 'https://deck.wang.team/house/'}} onOpen=${open} />`}
      onMore=${() => c.key('Group:section:actions')} />
    <${Asks} asks=${asks} onAsk=${onAsk} fold=${fold} />
    ${tower ? html`<${Plans} plans=${model.plans} error=${model.errors.plans} retry=${() => model.refresh()} host=${host} fold=${fold} limit=${4} onOpen=${open} url=${`${TOWER}/usage/`} />
    <${Fleet} compact=${true} fleet=${model.fleet} error=${model.errors.fleet} retry=${() => model.refresh()} host=${host} fold=${fold} onOpen=${open} url=${TOWER} />` : null}
  </div>`;
}
