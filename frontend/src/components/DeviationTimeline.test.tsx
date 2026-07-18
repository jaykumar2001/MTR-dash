import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeviationTimeline } from './DeviationTimeline.js';
import type { Deviation } from '../types.js';

const deviations: Deviation[] = [
  { id: 2, ttl: 1, oldHost: 'A', newHost: 'B', detectedAt: '2026-07-06T10:00:00.000Z' },
  { id: 1, ttl: 1, oldHost: null, newHost: 'A', detectedAt: '2026-07-06T09:00:00.000Z' },
];

describe('DeviationTimeline', () => {
  it('renders each deviation and calls onScrub with its timestamp when clicked', () => {
    const onScrub = vi.fn();
    render(<DeviationTimeline deviations={deviations} onScrub={onScrub} />);
    fireEvent.click(screen.getByText(/A -> B/));
    expect(onScrub).toHaveBeenCalledWith('2026-07-06T10:00:00.000Z');
  });
});
