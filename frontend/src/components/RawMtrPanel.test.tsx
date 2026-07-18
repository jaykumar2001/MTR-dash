import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawMtrPanel } from './RawMtrPanel.js';
import type { RunHistoryEntry } from '../types.js';

const run: RunHistoryEntry = {
  id: 2,
  startedAt: '2026-07-08T10:01:00.000Z',
  hops: [
    { ttl: 1, host: '10.0.0.1', lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
  ],
};

describe('RawMtrPanel', () => {
  it("renders the given run's hop rows", () => {
    render(<RawMtrPanel run={run} />);
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
  });

  it('renders the run header timestamp', () => {
    const { container } = render(<RawMtrPanel run={run} />);
    const header = container.querySelector('.raw-mtr-run-header');
    expect(header?.textContent).toContain(new Date('2026-07-08T10:01:00.000Z').toLocaleString());
  });

  it('still renders a table for a run with no hops', () => {
    const emptyRun: RunHistoryEntry = { id: 1, startedAt: '2026-07-08T10:00:00.000Z', hops: [] };
    const { container } = render(<RawMtrPanel run={emptyRun} />);
    expect(container.querySelector('.raw-mtr-table')).not.toBeNull();
  });

  it('renders nothing extra when run is null', () => {
    const { container } = render(<RawMtrPanel run={null} />);
    expect(container.querySelector('.raw-mtr-run')).toBeNull();
  });
});
