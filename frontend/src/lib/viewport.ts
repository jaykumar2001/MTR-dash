import type { Viewport } from '@xyflow/react';

// Per-target map viewport (pan x/y + zoom), persisted browser-side so a
// zoom/pan the user chose survives data refreshes, target switches, and page
// reloads. Same localStorage conventions as useTheme: best-effort writes,
// treat anything unreadable as absent.
const STORAGE_PREFIX = 'mtr-dash-viewport:';

export function loadViewport(targetId: number): Viewport | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${targetId}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Viewport>;
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.zoom !== 'number'
    ) {
      return null;
    }
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    return null;
  }
}

export function saveViewport(targetId: number, viewport: Viewport): void {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${targetId}`,
      JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
    );
  } catch {
    // localStorage unavailable (e.g. private browsing) — the viewport still
    // applies for this session, it just won't persist across reloads.
  }
}
