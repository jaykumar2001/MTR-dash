# Preset Color Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four preset color themes (2 dark, 2 light, paired by accent hue), selectable from a
swatch switcher in the top bar, persisted across reloads.

**Architecture:** Each preset is a `[data-theme="..."]` CSS block overriding the same custom
properties already declared on `:root`. A `useTheme` hook owns the current theme id, applies it
to `document.documentElement`, and persists it to `localStorage`; a `ThemeSwitcher` component
renders one clickable swatch per preset and is wired into `App.tsx`'s header.

**Tech Stack:** React + Vite (frontend only — no backend changes), Vitest + Testing Library.

## Global Constraints

- Four presets: `dark-patch-panel` (existing values, default), `dark-slate`, `light-paper`,
  `light-slate`. Exact hex values below, copied verbatim from the spec.
- Status colors (`--status-good`/`--status-warn`/`--status-bad` and `-dim` variants) never change
  per theme — they encode real network-health state, not decoration.
- Persistence key: `localStorage` under `mtr-dash-theme`. An unknown/invalid stored value falls
  back to `dark-patch-panel`; `localStorage` being unavailable must not crash the app.
- Both `tsconfig.json`s use `strict: true`; there is no ESLint/Prettier. `npm run build` (`tsc`)
  is the only type-check gate.

---

### Task 1: Theme data + `useTheme` hook

**Files:**
- Create: `frontend/src/lib/themes.ts`
- Create: `frontend/src/hooks/useTheme.ts`
- Test: `frontend/src/hooks/useTheme.test.ts`

**Interfaces:**
- Produces: `ThemePreset { id: string, label: string, accent: string }`, `THEMES: ThemePreset[]`,
  `DEFAULT_THEME: string` (from `themes.ts`) and `useTheme(): [string, (id: string) => void]`
  (from `useTheme.ts`) — consumed by Task 2 (`ThemeSwitcher` reads `THEMES`) and Task 3 (`App.tsx`
  calls `useTheme()`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/hooks/useTheme.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/hooks/useTheme.test.ts`
Expected: FAIL — `Cannot find module './useTheme.js'`

- [ ] **Step 3: Create the theme data**

Create `frontend/src/lib/themes.ts`:

```ts
export interface ThemePreset {
  id: string;
  label: string;
  accent: string;
}

export const THEMES: ThemePreset[] = [
  { id: 'dark-patch-panel', label: 'Patch Panel', accent: '#e8622c' },
  { id: 'dark-slate', label: 'Dark Slate', accent: '#2fb8c9' },
  { id: 'light-paper', label: 'Paper', accent: '#d1531f' },
  { id: 'light-slate', label: 'Light Slate', accent: '#0f7f8f' },
];

export const DEFAULT_THEME = 'dark-patch-panel';
```

- [ ] **Step 4: Implement `useTheme`**

Create `frontend/src/hooks/useTheme.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_THEME, THEMES } from '../lib/themes.js';

const STORAGE_KEY = 'mtr-dash-theme';

function isKnownTheme(value: string | null): value is string {
  return value !== null && THEMES.some((t) => t.id === value);
}

function readStoredTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isKnownTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function useTheme(): [string, (id: string) => void] {
  const [theme, setThemeState] = useState<string>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    setThemeState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable (e.g. private browsing) — theme still
      // applies for this session, it just won't persist across reloads.
    }
  }, []);

  return [theme, setTheme];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/hooks/useTheme.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/lib/themes.ts src/hooks/useTheme.ts src/hooks/useTheme.test.ts
git commit -m "Add theme presets data and useTheme hook"
```

---

### Task 2: `ThemeSwitcher` component

**Files:**
- Create: `frontend/src/components/ThemeSwitcher.tsx`
- Test: `frontend/src/components/ThemeSwitcher.test.tsx`

**Interfaces:**
- Consumes: `THEMES: ThemePreset[]` from `frontend/src/lib/themes.ts` (Task 1).
- Produces: `ThemeSwitcher({ theme: string, onSelect: (id: string) => void })` — consumed by
  Task 3 (`App.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ThemeSwitcher.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ThemeSwitcher.test.tsx`
Expected: FAIL — `Cannot find module './ThemeSwitcher.js'`

- [ ] **Step 3: Implement `ThemeSwitcher`**

Create `frontend/src/components/ThemeSwitcher.tsx`:

```tsx
import { THEMES } from '../lib/themes.js';

interface ThemeSwitcherProps {
  theme: string;
  onSelect: (id: string) => void;
}

export function ThemeSwitcher({ theme, onSelect }: ThemeSwitcherProps) {
  return (
    <div className="theme-switcher">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`theme-swatch${t.id === theme ? ' active' : ''}`}
          style={{ background: t.accent }}
          title={t.label}
          aria-label={t.label}
          onClick={() => onSelect(t.id)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/ThemeSwitcher.test.tsx`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/components/ThemeSwitcher.tsx src/components/ThemeSwitcher.test.tsx
git commit -m "Add ThemeSwitcher swatch component"
```

---

### Task 3: Wire into `App.tsx`, add theme CSS

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `useTheme(): [string, (id: string) => void]` (Task 1),
  `ThemeSwitcher({ theme, onSelect })` (Task 2).

- [ ] **Step 1: Write the failing test**

In `frontend/src/App.test.tsx`, add `localStorage.clear();` as the first line of the existing
`beforeEach` block (so a theme selection made by one test doesn't leak into the next):

```ts
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listTargets).mockResolvedValue([
```

(The rest of the `beforeEach` body is unchanged — only the new `localStorage.clear()` line is
added before the existing `vi.clearAllMocks()` line.)

Then add a new test, after `'loads targets and shows the selected target host in the config panel'`:

```tsx
  it('renders the theme switcher in the header', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    const header = document.querySelector('.app-header') as HTMLElement;
    expect(within(header).getByLabelText('Patch Panel')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — no element with label "Patch Panel" exists in the header yet.

- [ ] **Step 3: Wire `useTheme`/`ThemeSwitcher` into `App.tsx`**

In `frontend/src/App.tsx`, add the imports:

```ts
import { ThemeSwitcher } from './components/ThemeSwitcher.js';
import { useTheme } from './hooks/useTheme.js';
```

Inside the `App` function, add (alongside the other `useState`/hook calls near the top):

```ts
  const [theme, setTheme] = useTheme();
```

In the `<header className="app-header">` block, add `<ThemeSwitcher .../>` after the existing
`brand-sub` span:

```tsx
      <header className="app-header">
        <span className="brand">MTR Dashboard</span>
        <span className="brand-sub">
          {selectedTarget ? `probing ${selectedTarget.host}` : 'no target selected'}
        </span>
        <ThemeSwitcher theme={theme} onSelect={setTheme} />
      </header>
```

- [ ] **Step 4: Add theme CSS**

In `frontend/src/styles.css`, add `justify-content: space-between;` to the `.app-header` block
(currently `display: flex; align-items: baseline; gap: 0.75rem; ...` with no `justify-content`):

```css
.app-header {
  grid-area: header;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow-panel);
  z-index: 1;
}
```

Immediately after the base `:root { ... }` block (the one containing `--bg: #1c1b18;` etc., before
the `@media (prefers-reduced-motion: no-preference)` block), add the three new theme blocks:

```css
:root[data-theme='dark-slate'] {
  --bg: #15191c;
  --surface: #1d2226;
  --surface-raised: #262c31;
  --surface-inset: #0f1214;
  --border: #3a4147;
  --border-strong: #4d565d;
  --text: #e4e9ec;
  --text-muted: #93a0a8;
  --text-faint: #7c8a92;
  --accent: #2fb8c9;
  --accent-strong: #4fd3e3;
  --on-accent: #04191c;
}

:root[data-theme='light-paper'] {
  --bg: #f5f1e8;
  --surface: #ffffff;
  --surface-raised: #fbf8f1;
  --surface-inset: #ece6d8;
  --border: #d8d0bd;
  --border-strong: #c2b89f;
  --text: #2a2620;
  --text-muted: #6b6455;
  --text-faint: #89826f;
  --accent: #d1531f;
  --accent-strong: #b8461a;
  --on-accent: #fff8f0;
}

:root[data-theme='light-slate'] {
  --bg: #eef2f4;
  --surface: #ffffff;
  --surface-raised: #f7fafb;
  --surface-inset: #e2e8eb;
  --border: #cdd6da;
  --border-strong: #b3bfc5;
  --text: #1e2528;
  --text-muted: #5c686e;
  --text-faint: #7c8a92;
  --accent: #0f7f8f;
  --accent-strong: #0c6874;
  --on-accent: #f0fbfd;
}
```

Immediately after the `.app-header .brand-sub { ... }` block, add the switcher styles:

```css
.theme-switcher {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.theme-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  cursor: pointer;
  padding: 0;
  transition:
    border-color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

.theme-swatch:hover {
  transform: scale(1.15);
}

.theme-swatch.active {
  border-color: var(--text);
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 3px var(--text);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Run the full frontend suite and typecheck to check for regressions**

Run: `cd frontend && npm test && npm run build`
Expected: PASS — all tests green, zero type errors. (Note: `App.test.tsx`'s `'loads targets and
shows the selected target host in the config panel'` test has a known pre-existing intermittent
flake unrelated to this change, documented in `HANDOFF.md`'s known issues — if only that specific
test fails, re-run once before treating it as a real regression.)

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/App.tsx src/App.test.tsx src/styles.css
git commit -m "Wire theme switcher into the top bar and add preset theme CSS"
```

---

### Task 4: Full-stack regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: PASS, no failures beyond the known pre-existing flaky test noted in Task 3 Step 6.

- [ ] **Step 2: Run the full frontend build**

Run: `cd frontend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 3: Run the full backend suite (unaffected by this plan, confirm no accidental breakage)**

Run: `cd backend && npm test`
Expected: PASS, no failures — this plan makes no backend changes.

- [ ] **Step 4: Run the full backend build**

Run: `cd backend && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Manually verify in the browser**

Start both dev servers (`cd backend && npm run dev`, `cd frontend && npm run dev`), and in the
top bar confirm: four small colored swatches appear at the right edge of the header; clicking
each one instantly recolors the whole app (chassis, text, accent) to that preset; the active
swatch shows a ring indicator; reloading the page keeps the last-selected theme.
