import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Copyable } from './Copyable.js';

describe('Copyable', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('copies the given text to the clipboard on click', () => {
    render(<Copyable text="1.1.1.1" />);
    fireEvent.click(screen.getByText('1.1.1.1'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('1.1.1.1');
  });

  it('stops the click from propagating to a parent handler', () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <Copyable text="1.1.1.1" />
      </div>,
    );
    fireEvent.click(screen.getByText('1.1.1.1'));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('renders custom children instead of the raw text when provided', () => {
    render(
      <Copyable text="1.1.1.1">
        <span>custom label</span>
      </Copyable>,
    );
    expect(screen.getByText('custom label')).toBeInTheDocument();
    expect(screen.queryByText('1.1.1.1', { selector: 'span.copyable' })).not.toBeInTheDocument();
  });
});
