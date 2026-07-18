import { useState, type FormEvent } from 'react';
import type { AddressFamily } from '../types.js';

export interface TargetFormValues {
  host: string;
  intervalSeconds: number;
  reportCycles: number;
  addressFamily: AddressFamily;
}

interface TargetFormProps {
  onSubmit: (values: TargetFormValues) => void;
}

export function TargetForm({ onSubmit }: TargetFormProps) {
  const [host, setHost] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [reportCycles, setReportCycles] = useState(10);
  const [addressFamily, setAddressFamily] = useState<AddressFamily>('auto');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!host.trim()) return;
    onSubmit({ host: host.trim(), intervalSeconds, reportCycles, addressFamily });
    setHost('');
  }

  return (
    <form className="target-form" onSubmit={handleSubmit}>
      <input
        aria-label="host"
        placeholder="IP or hostname"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <input
        aria-label="interval-seconds"
        type="number"
        min={10}
        value={intervalSeconds}
        onChange={(e) => setIntervalSeconds(Number(e.target.value))}
      />
      <input
        aria-label="report-cycles"
        type="number"
        min={1}
        value={reportCycles}
        onChange={(e) => setReportCycles(Number(e.target.value))}
      />
      <select
        aria-label="address-family"
        value={addressFamily}
        onChange={(e) => setAddressFamily(e.target.value as AddressFamily)}
      >
        <option value="auto">Auto</option>
        <option value="ipv4">IPv4</option>
        <option value="ipv6">IPv6</option>
      </select>
      <button type="submit">Add target</button>
    </form>
  );
}
