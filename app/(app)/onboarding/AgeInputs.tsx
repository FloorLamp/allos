"use client";

import { useState } from "react";

export default function AgeInputs({
  birthdate: initialBirthdate,
  age: initialAge,
  disabled,
}: {
  birthdate: string | null;
  age: number | null;
  disabled: boolean;
}) {
  const [birthdate, setBirthdate] = useState(initialBirthdate ?? "");
  const [age, setAge] = useState(initialAge == null ? "" : String(initialAge));

  return (
    <>
      <div>
        <label className="label" htmlFor="onboarding-birthdate">
          Birthdate
        </label>
        <input
          id="onboarding-birthdate"
          type="date"
          name="birthdate"
          value={birthdate}
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setBirthdate(value);
            if (value) setAge("");
          }}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Helps tailor age-based screenings, immunization schedules, and
          reference ranges.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="onboarding-age">
          Or approximate age
        </label>
        <input
          id="onboarding-age"
          type="number"
          name="age"
          min={1}
          max={149}
          value={age}
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setAge(value);
            if (value) setBirthdate("");
          }}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Use an estimate only when the birthdate is not known. Leave both blank
          if age is unknown.
        </p>
      </div>
    </>
  );
}
