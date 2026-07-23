# Path-highlight color scheme — design

Date: 2026-07-23
Status: approved

## Problem

The hover-path-highlight feature (shipped earlier today) only dims
everything *off* the hovered route — the route itself renders exactly as
it would with nothing hovered. On a busy map this makes the highlighted
path harder to spot at a glance than it should be: there's no positive
visual signal on the path itself, only the absence of dimming elsewhere.

## Decision

Give path elements an explicit, contrasting highlight treatment instead of
just leaving them unstyled:

- **Hop nodes** on the path get a strong accent-colored border + glow.
- **Cable-run edges** on the path get a thicker stroke and an
  accent-colored glow — but keep their existing `stroke` color (the
  green/yellow/red/grey loss-status signal) untouched. That color is a
  fixed signal, not a theme or highlight choice (see this project's
  `CLAUDE.md`), so hovering a lossy segment must not visually launder it
  into "looks fine now."
- The highlight color is the theme's existing `--accent`/`--accent-strong`
  custom properties — the same family already used for the origin node's
  border/glow — so it stays consistent across every theme preset
  automatically, rather than introducing a new fixed color that could
  clash with some themes.

Rejected alternative: replacing the edge's `stroke` with the highlight
color while hovered. Rejected because it would hide the loss-status color
for exactly the segment the user is looking at — the one moment that
information matters most.

## Data model change

A third per-element state, alongside the existing `dimmed`:

- `dimmed: true` — a hover is active, this element is NOT on the route.
- `highlighted: true` — a hover is active, this element IS on the route.
- Both `false` — no hover is active (today's default, unstyled look).

`dimmed` and `highlighted` are mutually exclusive by construction (an
element is either on the highlighted path or it isn't), computed the same
place `dimmed` already is: `NetworkMap.tsx`'s `renderedNodes`/
`renderedEdges` memos, from the same `pathHighlight` set.

## Changes by layer

### `frontend/src/components/NetworkMap.tsx`

- `renderedNodes`/`renderedEdges` (already computing `dimmed`) also compute
  `highlighted: pathHighlight !== null && pathHighlight.nodeIds.has(node.id)`
  (and the edge equivalent using `edgeIds`).

### `frontend/src/components/HopNode.tsx`

- `HopNodeData` gains `highlighted?: boolean`.
- Root `<div>`'s className gains `' path-highlighted'` when true (named
  distinctly from the node's own `active`/`inactive` semantic state, to
  avoid confusion between "this hop responded" and "this hop is on the
  hovered route").

### `frontend/src/styles.css`

- `.hop-node.path-highlighted`: `opacity: 1` (overrides `.inactive`'s 0.5,
  since a stale node specifically being highlighted should render fully
  visible, not muted), `border-color: var(--accent-strong)`, and a
  `box-shadow` glow using `var(--accent)` (replacing, not layering onto,
  the base panel shadow — same pattern `.origin` already uses). Placed
  after `.inactive`/`.dimmed`/`.origin` in source order so it wins the
  cascade whenever it applies alongside any of them (equal specificity,
  later wins) — including the case where the origin node itself becomes
  the target of a highlight.

### `frontend/src/components/MetricEdge.tsx`

- `MetricEdgeData` gains `highlighted: boolean` (required, matching
  `dimmed`'s convention).
- `<BaseEdge>`'s inline `style` gains a conditional `filter` — a
  `drop-shadow` glow using `var(--accent-strong)`/`var(--accent)` — and a
  `strokeWidth` of 5, thicker than both the normal 3px and the
  selected-state 4px, since "on the highlighted path" is a stronger signal
  than either. `stroke`/`color` (the loss-status color) are unchanged.
- Inline `style.filter` takes precedence over the existing stylesheet
  `:hover`/`.selected` glow rule (`filter: drop-shadow(0 0 3px
  currentColor)`) for the specific edge directly under the cursor, which
  is always included in its own highlight set — that's fine and arguably
  better: the direct hover target ends up with the same prominent glow as
  the rest of its route, not a dimmer self-only one.

## Behavior notes

- No change to when highlighting turns on/off — this only changes how an
  already-highlighted element looks, not the path-computation logic from
  the earlier feature.
- A node/edge can never be simultaneously `dimmed` and `highlighted` (the
  underlying Sets are complementary), so no CSS specificity conflict
  between the two treatments can arise in practice.

## Testing

Vitest + Testing Library, colocated per repo convention:

- `HopNode.test.tsx`: renders `.path-highlighted` class when
  `highlighted: true`, omits it otherwise.
- `MetricEdge.test.tsx`: renders a `filter` style containing `drop-shadow`
  when `highlighted: true`, no `filter` otherwise; confirms `stroke` is
  unaffected by `highlighted` (still reflects `color` regardless).
- `NetworkMap.test.tsx`: extend the existing `describe('path hover
  highlighting', ...)` tests to also assert `highlighted`/`.path-highlighted`
  presence on path elements (currently they only assert the absence of
  `dimmed`) for at least the node-hover and edge-hover cases.

## Out of scope

- Any user-facing control over the highlight color (e.g. a settings
  toggle) — it's derived from the active theme, not independently
  configurable.
- Changing the dimming behavior/opacity values from the earlier feature —
  unchanged here.
