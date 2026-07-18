# Per-target address family (-4/-6) — design

Date: 2026-07-16
Status: approved

## Problem

`mtr` probes exactly one address per run: the first result `getaddrinfo` returns for the
target host. For dual-stack hostnames in the Docker container this is effectively always
IPv4 (the container's only IPv6 address is a ULA, which RFC 6724 deprioritizes against
global IPv6 destinations). There is currently no way to monitor the IPv6 path of a
dual-stack hostname short of entering a literal IPv6 address.

## Decision

Add a per-target setting `addressFamily: 'auto' | 'ipv4' | 'ipv6'`.

- `auto` (default): current behavior — no family flag passed, resolver decides.
- `ipv4`: append `-4` to the mtr invocation.
- `ipv6`: append `-6` to the mtr invocation.

Rejected alternatives: a boolean `forceIpv6` (asymmetric — forcing `-4` is equally
legitimate); auto-creating paired v4/v6 targets (pairing/grouping machinery for something
achievable by adding the target twice).

## Changes by layer

Wiring follows the existing `maxStaleHops` precedent end to end.

### Database

- `schema.sql`: `address_family TEXT NOT NULL DEFAULT 'auto'` on `targets`.
- `db/client.ts`: guarded `ALTER TABLE targets ADD COLUMN` for existing databases,
  same pattern as `max_stale_hops`.

### Backend

- `services/targets.ts`: `addressFamily` on `Target`, create/update inputs, and the row
  mapping. Values validated to the three literals.
- Save-time validation: if `host` is a literal IP (`node:net` `isIP`) whose family
  contradicts a non-`auto` setting (e.g. `8.8.8.8` with `ipv6`), reject with 400 —
  otherwise every scheduled poll would fail silently.
- `mtr/runner.ts`: `runMtr(host, cycles, family?, mtrBin?)` appends `-4`/`-6` when
  family is not `auto`/undefined.
- `scheduler/scheduler.ts`: passes `target.addressFamily` to the runner.
- `routes/targets.ts`: accepts `addressFamily` in POST/PUT bodies.

### Frontend

- `types.ts` / `api/client.ts`: field added to the target type and create/update payloads.
- `ConfigPanel.tsx`: three-option select (Auto / IPv4 / IPv6) next to the existing
  stale-hops control; defaults to Auto.

## Behavior notes

- Switching an existing target's family produces a full-path deviation (every hop changes
  host). That is the deviation system working as designed — identical to a real route
  change — so no special handling.
- No backfill or data migration: existing targets get `'auto'` and behave exactly as
  before.

## Testing

Vitest, colocated with each touched file per repo convention:

- `runner.test.ts`: arg construction for all three values (no flag for `auto`).
- `services/targets.test.ts`: persistence round-trip, default `'auto'`, rejection of
  invalid values and contradictory literal-IP/family combinations.
- `routes/targets.test.ts`: 400 on contradictory literal IP; field accepted on POST/PUT.
- `scheduler` test: family forwarded to the injected `runMtrFn`.
- `ConfigPanel.test.tsx`: select renders, default Auto, value submitted.

## Out of scope

- Giving the container a global (non-ULA) IPv6 address so `auto` prefers AAAA naturally
  (infrastructure choice, orthogonal to this feature).
- Any pairing/grouping of v4+v6 targets for the same hostname.
