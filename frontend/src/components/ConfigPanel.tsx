import { useEffect, useState, type FormEvent } from 'react';
import type { Target } from '../types.js';

interface ConfigPanelProps {
  target: Target;
  onSave: (values: {
    intervalSeconds: number;
    reportCycles: number;
    maxStaleHops: number;
  }) => void;
}

export function ConfigPanel({ target, onSave }: ConfigPanelProps) {
  const [intervalSeconds, setIntervalSeconds] = useState(target.intervalSeconds);
  const [reportCycles, setReportCycles] = useState(target.reportCycles);
  const [maxStaleHops, setMaxStaleHops] = useState(target.maxStaleHops);

  // `target` is looked up fresh from App's `targets` list on every render,
  // not a value this component owns — if the target's config changes by any
  // means other than this form's own Save button (e.g. re-fetched after some
  // other update), the fields must follow it rather than silently keep
  // showing whatever was true when this component first mounted.
  useEffect(() => {
    setIntervalSeconds(target.intervalSeconds);
    setReportCycles(target.reportCycles);
    setMaxStaleHops(target.maxStaleHops);
  }, [target.id, target.intervalSeconds, target.reportCycles, target.maxStaleHops]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave({ intervalSeconds, reportCycles, maxStaleHops });
  }

  return (
    <form className="config-panel" onSubmit={handleSubmit}>
      <label>
        Interval (s)
        <input
          type="number"
          min={10}
          value={intervalSeconds}
          onChange={(e) => setIntervalSeconds(Number(e.target.value))}
        />
      </label>
      <label>
        Report cycles
        <input
          type="number"
          min={1}
          value={reportCycles}
          onChange={(e) => setReportCycles(Number(e.target.value))}
        />
      </label>
      <label>
        Max stale hops
        <input
          type="number"
          min={0}
          max={5}
          value={maxStaleHops}
          onChange={(e) => setMaxStaleHops(Number(e.target.value))}
        />
      </label>
      <button type="submit">Save</button>
    </form>
  );
}
