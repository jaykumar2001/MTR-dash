import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigPanel } from './ConfigPanel.js';
import type { Target } from '../types.js';

const target: Target = {
  id: 1,
  host: '1.1.1.1',
  intervalSeconds: 60,
  reportCycles: 10,
  maxStaleHops: 1,
  addressFamily: 'auto',
  enabled: true,
  createdAt: '2026-07-06T00:00:00.000Z',
};

describe('ConfigPanel', () => {
  it('submits the edited interval and report cycles', () => {
    const onSave = vi.fn();
    render(<ConfigPanel target={target} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/interval/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith({ intervalSeconds: 30, reportCycles: 10, maxStaleHops: 1 });
  });

  it('submits the edited maxStaleHops', () => {
    const onSave = vi.fn();
    render(<ConfigPanel target={target} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/max stale hops/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith({
      intervalSeconds: 60,
      reportCycles: 10,
      maxStaleHops: 3,
    });
  });

  it('reflects an updated target prop without requiring a remount', () => {
    const { rerender } = render(<ConfigPanel target={target} onSave={vi.fn()} />);
    expect(screen.getByLabelText(/interval/i)).toHaveValue(60);
    expect(screen.getByLabelText(/max stale hops/i)).toHaveValue(1);

    // Same target, but its config changed by some means other than this
    // form's own Save button (e.g. re-fetched after an external update).
    rerender(<ConfigPanel target={{ ...target, intervalSeconds: 90 }} onSave={vi.fn()} />);

    expect(screen.getByLabelText(/interval/i)).toHaveValue(90);
    expect(screen.getByLabelText(/max stale hops/i)).toHaveValue(1);
  });

  it('resets to the new target defaults when switching to a different target', () => {
    const { rerender } = render(<ConfigPanel target={target} onSave={vi.fn()} />);

    const otherTarget: Target = { ...target, id: 2, intervalSeconds: 120, reportCycles: 5, maxStaleHops: 3 };
    rerender(<ConfigPanel target={otherTarget} onSave={vi.fn()} />);

    expect(screen.getByLabelText(/interval/i)).toHaveValue(120);
    expect(screen.getByLabelText(/report cycles/i)).toHaveValue(5);
    expect(screen.getByLabelText(/max stale hops/i)).toHaveValue(3);
  });

  it('does not offer an address family field — family is fixed at target creation', () => {
    render(<ConfigPanel target={target} onSave={vi.fn()} />);
    expect(screen.queryByLabelText(/address family/i)).toBeNull();
  });
});
