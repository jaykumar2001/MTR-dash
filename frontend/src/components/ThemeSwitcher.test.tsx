import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeSwitcher } from './ThemeSwitcher.js';
import { THEMES } from '../lib/themes.js';

describe('ThemeSwitcher', () => {
  it('renders one swatch per theme', () => {
    render(<ThemeSwitcher theme="dark-patch-panel" onSelect={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(THEMES.length);
  });

  it("marks the active theme's swatch", () => {
    render(<ThemeSwitcher theme="dark-slate" onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Dark Slate')).toHaveClass('active');
    expect(screen.getByLabelText('Patch Panel')).not.toHaveClass('active');
  });

  it('calls onSelect with the clicked theme id', () => {
    const onSelect = vi.fn();
    render(<ThemeSwitcher theme="dark-patch-panel" onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Paper'));
    expect(onSelect).toHaveBeenCalledWith('light-paper');
  });

  it("colors each swatch by that theme's accent", () => {
    render(<ThemeSwitcher theme="dark-patch-panel" onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Dark Slate')).toHaveStyle({ background: '#2fb8c9' });
  });
});
