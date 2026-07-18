import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from './useTheme.js';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to dark-patch-panel with no stored value', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('dark-patch-panel');
    expect(document.documentElement.dataset.theme).toBe('dark-patch-panel');
  });

  it('reads and applies a valid stored value on mount', () => {
    localStorage.setItem('mtr-dash-theme', 'dark-slate');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('dark-slate');
    expect(document.documentElement.dataset.theme).toBe('dark-slate');
  });

  it('falls back to default for an invalid/unknown stored value', () => {
    localStorage.setItem('mtr-dash-theme', 'not-a-real-theme');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('dark-patch-panel');
  });

  it('setTheme updates state, the DOM attribute, and localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current[1]('light-paper');
    });
    expect(result.current[0]).toBe('light-paper');
    expect(document.documentElement.dataset.theme).toBe('light-paper');
    expect(localStorage.getItem('mtr-dash-theme')).toBe('light-paper');
  });
});
