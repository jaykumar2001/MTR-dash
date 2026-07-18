import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';
import type { Target } from '../types.js';

const targets: Target[] = [
  {
    id: 1,
    host: '1.1.1.1',
    intervalSeconds: 60,
    reportCycles: 10,
    enabled: true,
    maxStaleHops: 1,
    addressFamily: 'auto',
    createdAt: '2026-07-06T00:00:00.000Z',
  },
];

describe('Sidebar', () => {
  it('renders each target and calls onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        targets={targets}
        selectedId={null}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('1.1.1.1'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('calls onDelete when the delete button is clicked', () => {
    const onDelete = vi.fn();
    render(
      <Sidebar
        targets={targets}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByLabelText('delete-1'));
    expect(onDelete).toHaveBeenCalledWith(1);
  });
});
