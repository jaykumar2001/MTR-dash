# Simplify Raw MTR Panel and Move Tables to Bottom — Design

## Problem

The raw-values panel (`RawMtrPanel`) currently shows up to 50 historical polls in a scrollable
list, one block per poll. In practice this adds no observability value — a scrolling history of
raw numbers isn't something anyone reads back through; what matters is what the most recent poll
reported. Meanwhile the three-column layout (raw panel | map | deviations) narrows the map, which
is the primary thing being observed.

## Goals

- The raw-values panel shows only the most recent poll's per-hop numbers, replaced in place as
  each new poll arrives — no history, no scrolling list.
- The map gets full width, maximizing the space given to the thing actually being watched.
- The raw-values table and the deviation timeline move to a bottom row, side by side, out of the
  map's way.

## Non-goals

- No backend changes. `GET /api/targets/:id/runs?limit=N` already supports fetching just the
  latest run via `limit=1`; this is a frontend-only change.
- No change to what data is shown per hop (still the exact raw `mtr` numbers) or to the deviation
  timeline's own behavior (scrubbing, click handling) — only its position on the page.

## Design

### `RawMtrPanel` — single-run display

`frontend/src/components/RawMtrPanel.tsx`'s props change from `{ runs: RunHistoryEntry[] }` to
`{ run: RunHistoryEntry | null }`. It renders one table (the given run's hops) instead of looping
over a list of blocks; `null` (no run yet, e.g. target just created) renders nothing extra beyond
the panel header. `RunHistoryEntry`/`RunHistoryHop` types (`frontend/src/types.ts`) are unchanged
— only the component's prop shape changes.

### `App.tsx` — fetch latest only

`refreshMap` calls `api.getRunHistory(targetId, 1)` instead of the default-50 call, and passes
`run={runHistory[0] ?? null}` to `RawMtrPanel` (the `runHistory` state itself stays
`RunHistoryEntry[]`, now just holding 0 or 1 entries — no new state shape needed).

### Layout — bottom row instead of three columns

`frontend/src/styles.css` / `frontend/src/App.tsx`: remove the `.main-columns` three-column row
entirely. New structure, top to bottom, all direct children of `main` (`display: flex;
flex-direction: column`, unchanged):

1. `ConfigPanel` + conditional history banner — unchanged, full width.
2. `NetworkMap` — `flex: 1`, full width, taking the remaining vertical space (this reverts it to
   how it sized before the three-column layout existed).
3. A new `.bottom-panels` row (`display: flex`, fixed/bounded height, not `flex: 1` — it should
   not compete with the map for vertical space): `RawMtrPanel` (left half, `flex: 1`) |
   `DeviationTimeline` (right half, `flex: 1`), each independently scrollable
   (`overflow-y: auto`) if their content exceeds the row's height. Height budget: ~220px,
   matching the deviation timeline's original pre-three-column `max-height: 190px` sizing
   closely enough to stay familiar.

`DeviationTimeline`'s own CSS reverts toward its original bottom-panel styling (`border-top`
instead of the three-column `border-left`, bounded height) rather than the right-column styling
added for the three-column layout. `RawMtrPanel`'s CSS gets the same treatment on its side
(bounded height, `border-top`, scrollable), mirrored as the left half of the same row.

Mobile responsive: the existing `.main-columns` stacking media-query rule is replaced by ensuring
`.bottom-panels` itself stacks to `flex-direction: column` under the existing
`@media (max-width: 760px)` breakpoint, consistent with how `.sidebar` already adapts there.

## Testing

- `RawMtrPanel.test.tsx`: rewritten for the new `{ run }` prop — renders the given run's hop
  table, renders nothing extra for `run={null}`, still renders a table (empty body) for a
  zero-hop run.
- `App.test.tsx`: `api.getRunHistory` mock assertion updated to expect `(1, 1)` (or whatever the
  final call signature is) instead of the default; layout test updated to assert `.bottom-panels`
  contains `raw-mtr-panel` and `deviation-timeline` side by side, and that `NetworkMap` is a
  full-width sibling above that row, not inside a three-column wrapper.
