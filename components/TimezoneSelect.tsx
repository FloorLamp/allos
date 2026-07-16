"use client";

import { useEffect, useMemo, useState } from "react";
import Combobox from "@/components/Combobox";
import { formatTimezoneOffset } from "@/lib/timezone";

type IntlWithTimezones = typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

export default function TimezoneSelect({
  id,
  name = "timezone",
  value,
  disabled = false,
  onTimezoneChange,
  className = "",
}: {
  id: string;
  name?: string;
  value: string;
  disabled?: boolean;
  onTimezoneChange?: (timezone: string) => void;
  className?: string;
}) {
  const [timezone, setTimezone] = useState(value);
  const [tzList, setTzList] = useState<string[]>([]);
  const [query, setQuery] = useState(() => timezoneLabel(value, new Date()));

  useEffect(() => {
    setTimezone(value);
    setQuery(timezoneLabel(value, new Date()));
  }, [value]);
  useEffect(() => {
    const zones = (Intl as IntlWithTimezones).supportedValuesOf?.("timeZone");
    if (zones) setTzList(zones);
  }, []);

  const options = useMemo(() => {
    const zones = tzList.includes(timezone) ? tzList : [timezone, ...tzList];
    const now = new Date();
    return zones.map((zone) => ({
      zone,
      label: timezoneLabel(zone, now),
    }));
  }, [timezone, tzList]);
  const labels = options.map((option) => option.label);
  const zonesByLabel = new Map(
    options.map((option) => [option.label, option.zone])
  );

  function choose(next: string) {
    setTimezone(next);
    setQuery(timezoneLabel(next, new Date()));
    onTimezoneChange?.(next);
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <label className="label mb-0" htmlFor={id}>
          Timezone
        </label>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
              if (detected) choose(detected);
            }}
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Detect from browser
          </button>
        )}
      </div>
      <Combobox
        id={id}
        value={query}
        onChange={setQuery}
        options={labels}
        onPick={(label) => {
          const zone = zonesByLabel.get(label);
          if (zone) choose(zone);
        }}
        onInputBlur={() => setQuery(timezoneLabel(timezone, new Date()))}
        selectOnFocus
        disabled={disabled}
        emptyLabel="No timezone found"
        placeholder="Search by city, region, or UTC offset"
        inputClassName="mt-1"
      />
      <input type="hidden" name={name} value={timezone} disabled={disabled} />
    </div>
  );
}

function timezoneLabel(timezone: string, at: Date): string {
  return `(${formatTimezoneOffset(timezone, at)}) ${timezone.replaceAll("_", " ")}`;
}
