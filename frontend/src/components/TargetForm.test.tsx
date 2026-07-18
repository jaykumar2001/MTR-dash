import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TargetForm } from './TargetForm.js';

describe('TargetForm', () => {
  it('submits host, interval, cycles, and address family', () => {
    const onSubmit = vi.fn();
    render(<TargetForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('host'), { target: { value: '1.1.1.1' } });
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      host: '1.1.1.1',
      intervalSeconds: 60,
      reportCycles: 10,
      addressFamily: 'auto',
    });
  });

  it('submits the selected address family', () => {
    const onSubmit = vi.fn();
    render(<TargetForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('host'), { target: { value: '2606:4700::1111' } });
    fireEvent.change(screen.getByLabelText('address-family'), { target: { value: 'ipv6' } });
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      host: '2606:4700::1111',
      intervalSeconds: 60,
      reportCycles: 10,
      addressFamily: 'ipv6',
    });
  });

  it('does not submit with an empty host', () => {
    const onSubmit = vi.fn();
    render(<TargetForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
