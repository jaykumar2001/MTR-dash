import { describe, expect, it, beforeEach } from 'vitest';
import { loadViewport, saveViewport } from './viewport.js';

describe('viewport persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a viewport per target', () => {
    saveViewport(1, { x: 12.5, y: -30, zoom: 1.75 });
    saveViewport(2, { x: 0, y: 0, zoom: 0.4 });

    expect(loadViewport(1)).toEqual({ x: 12.5, y: -30, zoom: 1.75 });
    expect(loadViewport(2)).toEqual({ x: 0, y: 0, zoom: 0.4 });
  });

  it('returns null for a target with no saved viewport', () => {
    expect(loadViewport(99)).toBeNull();
  });

  it('returns null for corrupt or incomplete stored values', () => {
    localStorage.setItem('mtr-dash-viewport:1', 'not json');
    localStorage.setItem('mtr-dash-viewport:2', JSON.stringify({ x: 1, y: 2 }));
    localStorage.setItem('mtr-dash-viewport:3', JSON.stringify({ x: '1', y: 2, zoom: 3 }));

    expect(loadViewport(1)).toBeNull();
    expect(loadViewport(2)).toBeNull();
    expect(loadViewport(3)).toBeNull();
  });
});
