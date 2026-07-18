# Preset Color Themes — Design

## Problem

The frontend's "Patch Panel" visual identity (warm charcoal chassis, orange accent) is fixed —
there's no way to switch it. The design is already built entirely on CSS custom properties
defined once on `:root` (`frontend/src/styles.css`), which makes it a good foundation for
swappable presets, but nothing today reads or sets more than that one fixed set of values.

## Goals

- A small set of preset color themes, selectable from a control in the top bar.
- Two dark variants and two light variants, each pair sharing an accent hue so a dark preset and
  its light counterpart read as the same "brand," just inverted.
- The selection persists across reloads.

## Non-goals

- Custom/user-defined color pickers — presets only, no arbitrary color customization.
- Per-component theming beyond what the existing CSS custom properties already cover — no new
  themeable surfaces are introduced, only alternate values for the ones that already exist.
- Changing the meaning or values of the status colors (`--status-good`/`--status-warn`/
  `--status-bad` and their `-dim` variants) — these encode real network-health state (the
  red/amber/green "port LED" convention already documented in `styles.css`), not decoration, and
  stay identical across every theme so "red" always means the same thing regardless of which
  preset is active.

## Design

### Theme definitions

Four presets, each overriding the same custom properties already declared on `:root` (chassis:
`--bg`/`--surface`/`--surface-raised`/`--surface-inset`/`--border`/`--border-strong`; text:
`--text`/`--text-muted`/`--text-faint`; accent: `--accent`/`--accent-strong`/`--on-accent`).
Fonts, radii, shadows, and status colors are unaffected — they stay the single global values
already on `:root`.

| Theme | Chassis | Accent |
|---|---|---|
| `dark-patch-panel` (default, existing values, unchanged) | Warm charcoal | Orange |
| `dark-slate` (new) | Cool dark gray | Cyan |
| `light-paper` (new) | Warm off-white | Orange (matches Patch Panel) |
| `light-slate` (new) | Cool light gray | Cyan (matches Dark Slate) |

Exact values (chosen to preserve the existing contrast ratios/legibility conventions already
established by the current dark theme, extended to light backgrounds):

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

`dark-patch-panel` needs no new block — it's the values already on the base `:root` selector,
used whenever `data-theme` is absent or explicitly set to that value.

### Mechanism

A `data-theme` attribute is set on `document.documentElement` (`<html>`). Because
`:root[data-theme='x']` has higher specificity than the bare `:root` block declaring the
defaults, each preset's overrides win without `!important` or restructuring any existing CSS —
every component that already consumes `var(--bg)` etc. picks up the new values automatically,
with zero component-level changes.

### State and persistence

New `frontend/src/lib/themes.ts`: a `THEMES` array of `{ id, label, accent }` (the four presets
above; `accent` is the swatch's own display color, read directly from the hex values above rather
than re-deriving them from CSS at runtime) and a `DEFAULT_THEME = 'dark-patch-panel'` constant.

New `frontend/src/hooks/useTheme.ts`: reads `localStorage.getItem('mtr-dash-theme')` on mount
(falling back to `DEFAULT_THEME` if unset or the stored value isn't a known theme id), applies it
to `document.documentElement.dataset.theme` in a `useEffect`, and returns `[theme, setTheme]`
where `setTheme` both updates state and writes through to `localStorage`.

### UI

New `frontend/src/components/ThemeSwitcher.tsx`: renders one circular swatch `<button>` per
entry in `THEMES`, background-colored via that theme's `accent` value, with a visible ring/border
on whichever one matches the current theme. Clicking a swatch calls `setTheme(theme.id)`.

`frontend/src/App.tsx`'s `<header className="app-header">` gets `<ThemeSwitcher
theme={theme} onSelect={setTheme} />` added after the existing `brand`/`brand-sub` spans.
`.app-header`'s CSS gains `justify-content: space-between` (it currently has no `justify-content`,
relying on natural flex packing) so the switcher lands at the right edge of the bar without
disturbing the existing brand text's position on the left.

## Edge cases

- Unknown/corrupted `localStorage` value (e.g. from a future removed theme, or manual tampering):
  `useTheme` falls back to `DEFAULT_THEME` rather than applying an invalid `data-theme` value
  that would match no CSS block (which would silently fall through to the bare `:root` values
  anyway — but validating explicitly keeps the returned `theme` state accurate for the switcher's
  active-ring indicator).
- No `localStorage` access (e.g. private browsing with storage disabled): reads/writes are
  wrapped so a thrown exception there doesn't crash the app — theme just resets to default each
  session in that case.

## Testing

- `useTheme.test.ts`: defaults to `dark-patch-panel` with no stored value; reads and applies a
  valid stored value on mount; falls back to default for an invalid/unknown stored value;
  `setTheme` updates both the returned state and `document.documentElement.dataset.theme`, and
  writes through to `localStorage`.
- `ThemeSwitcher.test.tsx`: renders one swatch per theme; the active theme's swatch is visually
  marked (e.g. a distinguishing class/attribute); clicking a swatch calls the provided `onSelect`
  with that theme's id.
- `App.test.tsx`: `ThemeSwitcher` renders inside `.app-header`.
