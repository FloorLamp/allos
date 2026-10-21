import {h} from '../../vendor/preact.mjs';
import {useId} from '../../vendor/hooks.mjs';

export function Button({variant = 'secondary', children, buttonRef, ...props}) {
  return h('button', {...props, ref: buttonRef, 'data-variant': variant}, children);
}

/** Label and descriptions stay connected when several forms share a page. `unit` sits inside the control's end (`kg`, `mg/dL`) and
 *  is read after the label. */
export function Field({as = 'input', label, hint, error, unit, id, children, ...props}) {
  const generated = useId(), controlId = id ?? generated;
  const descriptions = [props['aria-describedby'], unit && `${controlId}-unit`, hint && `${controlId}-hint`, error && `${controlId}-error`].filter(Boolean).join(' ');
  const control = h(as, {...props, id: controlId, 'aria-invalid': error ? 'true' : props['aria-invalid'], 'aria-describedby': descriptions || undefined}, children);
  return h('div', {class: 'dk-form-field'},
    h('label', {for: controlId}, label),
    unit ? h('div', {class: 'dk-field-unit'}, control, h('span', {id: `${controlId}-unit`}, unit)) : control,
    hint && h('small', {id: `${controlId}-hint`, class: 'dk-field-hint'}, hint),
    error && h('small', {id: `${controlId}-error`, class: 'dk-field-error'}, error));
}
