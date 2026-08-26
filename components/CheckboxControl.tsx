"use client";

import { useEffect, useRef, type ChangeEventHandler } from "react";

export interface CheckboxControlProps {
  /** The complete accessible name for the checkbox. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  "data-testid"?: string;
}

// The one bare-checkbox primitive. The associated label owns the phone/coarse
// target while the native box stays visibly 16px; callers cannot change either
// geometry or the control's tone.
export default function CheckboxControl({
  label,
  checked,
  onChange,
  disabled = false,
  indeterminate = false,
  "data-testid": testId,
}: CheckboxControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    onChange(event.target.checked);
  };

  return (
    <label className="checkbox-control" data-checkbox-control="">
      <input
        ref={inputRef}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        data-testid={testId}
        className="h-4 w-4 accent-brand-600"
      />
    </label>
  );
}
