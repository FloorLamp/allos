import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Button, Field} from './controls.js';
import {PageState} from './page-state.js';
import {FindBox} from './find-box.js';
import {Facts} from './drawer.js';
import {createHealthWorkflow, healthWorkflows} from '../health-workflow.js';
const html = htm.bind(h);
const types = new Set(['text', 'number', 'date', 'time', 'checkbox']);

function WorkflowForm({item, action, workflow, disabled}) {
  return html`<form onSubmit=${event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget), values = {};
    for (const field of action.fields ?? []) {
      const value = data.get(field.name);
      values[field.name] = field.type === 'checkbox' ? value === 'on' : field.type === 'number' ? (value === '' ? null : Number(value)) : value;
    }
    workflow.apply(item, action.id, values);
  }}><fieldset class="dh-fieldset" disabled=${disabled}><legend class="dk-label">${action.label}</legend><div class="dh-fields">
    ${(action.fields ?? []).map(field => field.type === 'select' ? html`<${Field} key=${field.name} as="select" label=${field.label} name=${field.name} required=${field.required} defaultValue=${field.value ?? ''}>
      ${(field.options ?? []).map(option => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}
    </${Field}>` : html`<${Field} key=${field.name} label=${field.label} hint=${field.hint} name=${field.name} type=${types.has(field.type) ? field.type : 'text'}
      required=${field.required} step=${field.type === 'number' ? 'any' : undefined} defaultChecked=${field.type === 'checkbox' ? field.value === true : undefined}
      defaultValue=${field.type === 'checkbox' ? undefined : field.value ?? ''} />`)}</div>
    <div class="dh-form-acts"><${Button} variant="primary" class="dk-btn">${action.label}</${Button}></div></fieldset></form>`;
}

export function HealthWorkflow({kind, profile, writable, host, onRecord}) {
  const [workflow, setWorkflow] = useState(null), [, redraw] = useState(0), [q, setQ] = useState('');
  useEffect(() => {
    const w = createHealthWorkflow(host);
    const off = w.subscribe(() => redraw(n => n + 1));
    setWorkflow(w); w.load(kind, profile);
    return () => { off(); w.stop(); };
  }, [host, kind, profile]);
  const w = workflow?.kind === kind && workflow?.profile === profile ? workflow : null;
  return html`<section class="dh-sec" aria-label=${healthWorkflows[kind]} aria-busy=${!w || w.loading}>
    <h2 class="dh-head"><span class="dk-label">${healthWorkflows[kind]}</span></h2>
    <${FindBox} label=${`Search ${healthWorkflows[kind].toLowerCase()}`} value=${q} onInput=${setQ} busy=${!!w?.loading}
      disabled=${!w || w.busy} onFind=${v => w?.load(kind, profile, v)} />
    <${PageState} state=${!w || w.loading ? 'loading' : undefined} backend="allos" host=${host} error=${w?.error} retry=${() => w?.load(kind, profile, q)}>
      ${w?.snapshot?.items?.length === 0 ? html`<${PageState} state="empty" hint="No items." />` : null}
      ${(w?.snapshot?.items ?? []).map(item => html`<article class="dh-item" key=${`${kind}:${profile}:${item.id}:${item.revision}`}>
        <div class="dh-item-head"><div><h3>${item.title}</h3>${item.summary ? html`<p>${item.summary}</p>` : null}</div>
        ${kind === 'documents' && typeof item.recordKey === 'string' ? html`<${Button} class="dk-btn" disabled=${w.loading || w.busy} onClick=${() => onRecord?.({key: item.recordKey, title: item.title, profile})}>Open document</${Button}>` : null}</div>
        ${item.facts?.length ? html`<${Facts} facts=${item.facts} />` : null}
        ${writable ? (item.actions ?? []).map(action => html`<${WorkflowForm} key=${action.id} item=${item} action=${action} workflow=${w} disabled=${w.loading || w.busy} />`) : null}
      </article>`)}
      ${w?.snapshot?.next ? html`<div class="dh-form-acts"><${Button} class="dk-btn" disabled=${w.loading || w.busy} onClick=${() => w.load(kind, profile, q, w.snapshot.next)}>Next page</${Button}></div>` : null}
    <//><p class="dh-status" role="status">${w?.status}</p>
  </section>`;
}
