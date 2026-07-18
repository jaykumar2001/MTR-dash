import type Database from 'better-sqlite3';
import { BridgeInferenceService } from './bridgeInference.js';

export interface MapNode {
  id: number | string;
  ttl: number;
  host: string;
  // The host actually recorded for this node's underlying path_nodes/hops
  // row, unaffected by any later display-only relabeling (e.g. known-bridge
  // substitution of a stale "???"). `deviations` rows are keyed on this raw
  // identity, so history-at-a-point-in-time matching must compare against
  // `rawHost`, never `host` — see the frontend's isHistoricallyActive.
  rawHost: string;
  active: boolean;
  x: number;
  y: number;
  hasCustomPosition: boolean;
  inferred: boolean;
}

export interface EdgeMetrics {
  lossPct: number;
  snt: number;
  last: number;
  avg: number;
  best: number;
  wrst: number;
  stdev: number;
}

export interface MapEdge {
  id: string;
  source: number | string;
  target: number | string;
  color: 'green' | 'yellow' | 'red' | 'grey';
  stale: boolean;
  avgLossPct?: number;
  latest?: EdgeMetrics;
}

export interface MapResult {
  nodes: MapNode[];
  edges: MapEdge[];
}

interface PathNodeRow {
  id: number;
  ttl: number;
  host: string;
  active: number;
}

const ROLLING_WINDOW = 5;

export class MapService {
  private bridgeInference: BridgeInferenceService;

  constructor(private db: Database.Database) {
    this.bridgeInference = new BridgeInferenceService(db);
  }

  getMap(targetId: number): MapResult {
    const targetRow = this.db
      .prepare('SELECT max_stale_hops FROM targets WHERE id = ?')
      .get(targetId) as { max_stale_hops: number } | undefined;
    const maxStaleHops = targetRow?.max_stale_hops ?? 0;

    const nodeRows = this.db
      .prepare('SELECT * FROM path_nodes WHERE target_id = ? ORDER BY ttl ASC')
      .all(targetId) as PathNodeRow[];

    const activeByTtl = new Map<number, PathNodeRow>();
    for (const n of nodeRows) if (n.active === 1) activeByTtl.set(n.ttl, n);

    const staleByTtl = new Map<number, PathNodeRow[]>();
    for (const n of nodeRows) {
      if (n.active === 1) continue;
      const list = staleByTtl.get(n.ttl) ?? [];
      list.push(n);
      staleByTtl.set(n.ttl, list);
    }

    // Get deactivation times for stale nodes from the deviations table.
    // We use the deviation id (auto-increment) rather than detected_at to handle cases
    // where multiple deviations occur in the same millisecond.
    const deactivatedId = new Map<number, number>();
    for (const rows of staleByTtl.values()) {
      for (const row of rows) {
        const deviation = this.db
          .prepare(
            `SELECT id FROM deviations
             WHERE target_id = ? AND ttl = ? AND old_host = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(targetId, row.ttl, row.host) as { id: number } | undefined;
        if (deviation) {
          deactivatedId.set(row.id, deviation.id);
        }
      }
    }

    const keptStaleIds = new Set<number>();
    for (const rows of staleByTtl.values()) {
      rows
        .slice()
        .sort((a, b) => {
          const aId = deactivatedId.get(a.id) ?? 0;
          const bId = deactivatedId.get(b.id) ?? 0;
          return bId - aId;
        })
        .slice(0, maxStaleHops)
        .forEach((r) => keptStaleIds.add(r.id));
    }

    const keptRows = nodeRows.filter((n) => n.active === 1 || keptStaleIds.has(n.id));

    const positions = new Map<number, { x: number; y: number }>();
    for (const p of this.db
      .prepare('SELECT node_id, x, y FROM node_positions WHERE target_id = ?')
      .all(targetId) as { node_id: number; x: number; y: number }[]) {
      positions.set(p.node_id, { x: p.x, y: p.y });
    }

    const nodes: MapNode[] = keptRows.map((n, idx) => {
      const custom = positions.get(n.id);
      const pos = custom ?? { x: idx * 220, y: n.active ? 0 : 140 };
      return {
        id: n.id,
        ttl: n.ttl,
        host: n.host,
        rawHost: n.host,
        active: n.active === 1,
        x: pos.x,
        y: pos.y,
        hasCustomPosition: custom !== undefined,
        inferred: false,
      };
    });

    const maxTtl = nodeRows.reduce((max, n) => Math.max(max, n.ttl), 0);
    const edges: MapEdge[] = [];

    for (let ttl = 1; ttl <= maxTtl; ttl++) {
      const curr = activeByTtl.get(ttl);
      if (!curr) continue;
      const prev = activeByTtl.get(ttl - 1);
      const sourceId = ttl === 1 ? 0 : prev?.id;
      if (sourceId === undefined) continue;

      const latestRow = this.db
        .prepare(
          `SELECT h.* FROM hops h
           JOIN runs r ON h.run_id = r.id
           WHERE r.target_id = ? AND h.ttl = ?
           ORDER BY r.id DESC LIMIT 1`,
        )
        .get(targetId, ttl) as
        | {
            loss_pct: number;
            snt: number;
            last: number;
            avg: number;
            best: number;
            wrst: number;
            stdev: number;
          }
        | undefined;

      const recentLoss = this.db
        .prepare(
          `SELECT h.loss_pct as lossPct FROM hops h
           JOIN runs r ON h.run_id = r.id
           WHERE r.target_id = ? AND h.ttl = ? AND h.host = ?
           ORDER BY r.id DESC LIMIT ?`,
        )
        .all(targetId, ttl, curr.host, ROLLING_WINDOW) as { lossPct: number }[];

      const avgLossPct = recentLoss.length
        ? recentLoss.reduce((sum, r) => sum + r.lossPct, 0) / recentLoss.length
        : 0;
      const color = avgLossPct > 5 ? 'red' : avgLossPct > 0 ? 'yellow' : 'green';

      edges.push({
        id: `${sourceId}-${curr.id}`,
        source: sourceId,
        target: curr.id,
        color,
        stale: false,
        avgLossPct,
        latest: latestRow
          ? {
              lossPct: latestRow.loss_pct,
              snt: latestRow.snt,
              last: latestRow.last,
              avg: latestRow.avg,
              best: latestRow.best,
              wrst: latestRow.wrst,
              stdev: latestRow.stdev,
            }
          : { lossPct: 0, snt: 0, last: 0, avg: 0, best: 0, wrst: 0, stdev: 0 },
      });
    }

    // Stale nodes connect to their TRUE historical neighbors — resolved from the
    // same run's hop snapshot the stale node was itself last active in — not to
    // whatever's active today. This is what correctly renders two adjacent hops
    // that changed together (e.g. b and c in a-b-c-d -> a-b'-c'-d) as a single
    // coherent stale segment (a-b-c-d), instead of splicing stale nodes onto
    // unrelated live ones.
    //
    // A historical neighbor host of "???" (mtr's no-reply sentinel) is never
    // resolved by string match — "???" isn't a real host identity, so two
    // separate "???" observations aren't provably the same physical hop. See
    // docs/superpowers/specs/2026-07-10-unresolved-hop-identity-design.md.
    const NO_REPLY_HOST = '???';
    const SOURCE_HOST = ' source';

    const nodeByTtlHost = new Map<string, number>();
    for (const n of keptRows) {
      nodeByTtlHost.set(`${n.ttl}:${n.host}`, n.id);
    }

    const nodeById = new Map<number | string, MapNode>();
    for (const n of nodes) nodeById.set(n.id, n);

    const lastActiveRunStmt = this.db.prepare(
      `SELECT MAX(h.run_id) as runId FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.ttl = ? AND h.host = ?`,
    );
    const hopAtTtlStmt = this.db.prepare('SELECT host FROM hops WHERE run_id = ? AND ttl = ?');

    const addedStaleEdgeIds = new Set<string>();
    const syntheticNodesById = new Map<string, MapNode>();
    const inferredNodesById = new Map<string, MapNode>();
    const gapChainCache = new Map<string, (number | string)[]>();

    const connectStale = (source: number | string, target: number | string) => {
      const id = `${source}-${target}`;
      if (addedStaleEdgeIds.has(id)) return;
      addedStaleEdgeIds.add(id);
      edges.push({ id, source, target, color: 'grey', stale: true });
    };

    interface GapWalk {
      ttls: number[]; // ascending ttl order
      boundBeforeHost: string | null; // real host (or SOURCE_HOST) just before ttls[0]; null if unresolved
      boundAfterHost: string | null; // real host just after ttls[last]; null if unresolved
    }

    // A gap's anchor is always a real path_node, but its own host can itself
    // be NO_REPLY_HOST (a "???" hop can go stale just like any other, e.g.
    // once a real host starts responding at that TTL). When that happens,
    // the anchor's own identity alone isn't a safe merge-key bound — walk
    // further, past the anchor, in `direction` to find the real host (or
    // SOURCE_HOST) that truly bounds this side of the gap. This is what lets
    // the same recurring gap (bounded by the same real hosts on both true
    // ends) be recognized as identical across separate occurrences even when
    // the specific node resolving it is itself an unresolved hop, instead of
    // falling back to a run-scoped token that can never match anything else.
    const findBound = (
      runId: number,
      fromTtl: number,
      fromHost: string,
      direction: 1 | -1,
    ): string | null => {
      if (fromHost !== NO_REPLY_HOST) return fromHost;
      let ttl = fromTtl + direction;
      for (;;) {
        if (direction === -1 && ttl === 0) return SOURCE_HOST;
        const hop = hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
        if (!hop) return null;
        if (hop.host !== NO_REPLY_HOST) return hop.host;
        ttl += direction;
      }
    };

    const walkGap = (
      runId: number,
      nodeTtl: number,
      nodeHost: string,
      direction: 1 | -1,
    ): GapWalk | null => {
      const ttls: number[] = [];
      let ttl = nodeTtl + direction;
      let farHost: string | null = null;
      for (;;) {
        if (direction === -1 && ttl === 0) {
          farHost = SOURCE_HOST;
          break;
        }
        const hop = hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
        if (!hop) {
          farHost = null;
          break;
        }
        if (hop.host !== NO_REPLY_HOST) {
          farHost = hop.host;
          break;
        }
        ttls.push(ttl);
        ttl += direction;
      }
      if (ttls.length === 0) return null;
      ttls.sort((a, b) => a - b);
      const anchorHost = findBound(runId, nodeTtl, nodeHost, direction === 1 ? -1 : 1);
      return direction === 1
        ? { ttls, boundBeforeHost: anchorHost, boundAfterHost: farHost }
        : { ttls, boundBeforeHost: farHost, boundAfterHost: anchorHost };
    };

    const gapKey = (span: GapWalk, runId: number): string => {
      const ttlStart = span.ttls[0];
      const ttlEnd = span.ttls[span.ttls.length - 1];
      const before = span.boundBeforeHost ?? `run:${runId}`;
      const after = span.boundAfterHost ?? `run:${runId}`;
      return `${ttlStart}-${ttlEnd}|${before}|${after}`;
    };

    const resolveGapChain = (span: GapWalk, runId: number): (number | string)[] => {
      const key = gapKey(span, runId);
      const cached = gapChainCache.get(key);
      if (cached) return cached;
      const chainIds = span.ttls.map((ttl) => `synthetic:${key}:${ttl}`);
      span.ttls.forEach((ttl, i) => {
        syntheticNodesById.set(chainIds[i], {
          id: chainIds[i],
          ttl,
          host: NO_REPLY_HOST,
          rawHost: NO_REPLY_HOST,
          active: false,
          x: ttl * 220,
          y: 140,
          hasCustomPosition: false,
          inferred: false,
        });
      });
      gapChainCache.set(key, chainIds);
      return chainIds;
    };

    // A gap bounded by two real, known hosts can sometimes be resolved to a
    // *specific* identity — not just an anonymous shared placeholder — when
    // this target's recent history shows exactly one distinct real sequence
    // ever connecting those same two hosts. Disagreement between historical
    // occurrences (e.g. ECMP/load-balanced routing) means no substitution,
    // ever — an anonymous "unknown" is always safer than a specific wrong
    // guess. See
    // docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md.
    const isRealHost = (host: string | null): host is string =>
      host !== null && host !== SOURCE_HOST && host !== NO_REPLY_HOST;

    // A resolved real host that's already independently tracked as a kept
    // node at that exact ttl (nodeByTtlHost already has it) is reused as-is
    // — it's a genuinely observed entity, not an inference, and creating a
    // second node for the same host/ttl would just be a visual duplicate.
    // Only hosts with no existing kept representation get a new, `inferred:
    // true` node.
    const createInferredChain = (hosts: string[], ttls: number[]): (number | string)[] =>
      ttls.map((ttl, i) => {
        const host = hosts[i];
        const existing = nodeByTtlHost.get(`${ttl}:${host}`);
        if (existing !== undefined) return existing;
        const id = `inferred:${ttl}:${host}`;
        if (!inferredNodesById.has(id)) {
          inferredNodesById.set(id, {
            id,
            ttl,
            host,
            rawHost: host,
            active: false,
            x: ttl * 220,
            y: 140,
            hasCustomPosition: false,
            inferred: true,
          });
        }
        return id;
      });

    // Recursively resolves a span of "???" ttls bounded by
    // (span.boundBeforeHost, span.boundAfterHost): tries a bridge covering
    // the whole span, then a known prefix or suffix (recursing on whatever's
    // left), and only falls back to one shared anonymous placeholder chain
    // (resolveGapChain, unchanged) for however much of the span no known
    // bridge can explain.
    const resolveGapSpan = (span: GapWalk, runId: number): (number | string)[] => {
      if (span.ttls.length === 0) return [];
      const left = span.boundBeforeHost;
      const right = span.boundAfterHost;
      const len = span.ttls.length;

      if (isRealHost(left) && isRealHost(right)) {
        const exact = this.bridgeInference.findExactBridge(targetId, left, right, len, 1);
        if (exact) return createInferredChain(exact, span.ttls);
      }

      if (len >= 2 && isRealHost(left)) {
        const prefix = this.bridgeInference.findKnownContinuation(targetId, left, len - 1, 1);
        if (prefix) {
          const prefixTtls = span.ttls.slice(0, prefix.length);
          const restTtls = span.ttls.slice(prefix.length);
          const prefixIds = createInferredChain(prefix, prefixTtls);
          const restIds = resolveGapSpan(
            { ttls: restTtls, boundBeforeHost: prefix[prefix.length - 1], boundAfterHost: right },
            runId,
          );
          return [...prefixIds, ...restIds];
        }
      }

      if (len >= 2 && isRealHost(right)) {
        const suffix = this.bridgeInference.findKnownContinuation(targetId, right, len - 1, -1);
        if (suffix) {
          const suffixAscending = suffix.slice().reverse();
          const suffixTtls = span.ttls.slice(len - suffix.length);
          const restTtls = span.ttls.slice(0, len - suffix.length);
          const suffixIds = createInferredChain(suffixAscending, suffixTtls);
          const restIds = resolveGapSpan(
            { ttls: restTtls, boundBeforeHost: left, boundAfterHost: suffixAscending[0] },
            runId,
          );
          return [...restIds, ...suffixIds];
        }
      }

      return resolveGapChain(span, runId);
    };

    const resolveThroughGap = (
      runId: number,
      ttl: number,
      host: string,
      direction: 1 | -1,
    ): number | string | undefined => {
      const walk = walkGap(runId, ttl, host, direction);
      if (!walk) return undefined;
      const chainIds = resolveGapSpan(walk, runId);
      for (let i = 0; i < chainIds.length - 1; i++) connectStale(chainIds[i], chainIds[i + 1]);

      if (direction === 1) {
        if (walk.boundAfterHost !== null) {
          const farTtl = walk.ttls[walk.ttls.length - 1] + 1;
          const resolved = nodeByTtlHost.get(`${farTtl}:${walk.boundAfterHost}`);
          if (resolved !== undefined) connectStale(chainIds[chainIds.length - 1], resolved);
        }
        return chainIds[0];
      }
      if (walk.boundBeforeHost === SOURCE_HOST) {
        connectStale(0, chainIds[0]);
      } else if (walk.boundBeforeHost !== null) {
        const farTtl = walk.ttls[0] - 1;
        const resolved = nodeByTtlHost.get(`${farTtl}:${walk.boundBeforeHost}`);
        if (resolved !== undefined) connectStale(resolved, chainIds[0]);
      }
      return chainIds[chainIds.length - 1];
    };

    // A stale node's own host can itself be NO_REPLY_HOST, sandwiched
    // directly between two real hosts in its own last-active snapshot (no
    // gap-walk needed to find them — they're its immediate historical
    // neighbors). This is the simplest, most common shape a known bridge
    // resolves — try it before the main per-node loop below, which only
    // ever resolves a stale node's *neighbor*, never the stale node's own
    // identity. If the resolved host already has an existing kept
    // representation at this ttl (most commonly: it's simply the currently
    // active node — this stale "???" is just an old poll that happened to
    // get no reply where the live path already shows the answer), the
    // live/existing edges already fully describe this connectivity, so this
    // node is dropped from the rendered map entirely rather than drawing a
    // second, necessarily-duplicate set of edges alongside them. With no
    // existing representation, this node is relabeled in place instead —
    // same id, same edges, just no longer a bare "???".
    const resolvedAwayNodeIds = new Set<number | string>();

    // Like findBound, but also returns the ttl the real (or SOURCE_HOST)
    // bound was found at — needed here to measure the *entire* contiguous
    // "???" run containing a stale node's own ttl (which may reach past
    // just its immediate neighbor), not only the immediately adjacent hop.
    const findRealBoundTtl = (
      runId: number,
      fromTtl: number,
      direction: 1 | -1,
    ): { host: string; ttl: number } | null => {
      let ttl = fromTtl + direction;
      for (;;) {
        if (direction === -1 && ttl === 0) return { host: SOURCE_HOST, ttl: 0 };
        const hop = hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
        if (!hop) return null;
        if (hop.host !== NO_REPLY_HOST) return { host: hop.host, ttl };
        ttl += direction;
      }
    };

    // Request-scoped memo for the full-history sole-identity fallback — the
    // lookup is deterministic within one getMap() call and multiple "???"
    // nodes can share a ttl. Steady-state maps with no "???" nodes never
    // execute it at all.
    const soleIdentityCache = new Map<number, string | null>();
    const soleIdentityAtTtl = (ttl: number): string | null => {
      if (!soleIdentityCache.has(ttl)) {
        soleIdentityCache.set(ttl, this.bridgeInference.findSoleIdentityAtTtl(targetId, ttl));
      }
      return soleIdentityCache.get(ttl)!;
    };

    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id));
      for (const staleNode of kept) {
        // No ttl floor: at ttl 1 the windowed path below fails on its own
        // (findRealBoundTtl yields SOURCE_HOST, which isRealHost rejects)
        // and the sole-identity fallback treats the source as the known
        // left bound.
        if (staleNode.host !== NO_REPLY_HOST) continue;

        // Primary: the recent-window walked-bounds bridge, exactly as before.
        let resolvedHost: string | null = null;
        const ownLastActiveRunId = (
          lastActiveRunStmt.get(targetId, ttl, staleNode.host) as { runId: number | null }
        ).runId;
        if (ownLastActiveRunId !== null) {
          const left = findRealBoundTtl(ownLastActiveRunId, ttl, -1);
          const right = findRealBoundTtl(ownLastActiveRunId, ttl, 1);
          if (left && right && isRealHost(left.host) && isRealHost(right.host)) {
            const bridge = this.bridgeInference.findExactBridge(
              targetId,
              left.host,
              right.host,
              right.ttl - left.ttl - 1,
              1,
            );
            if (bridge) resolvedHost = bridge[ttl - left.ttl - 1];
          }
        }
        // Fallback: full-history sole-identity. Strictly stricter on
        // identity count than any window, so falling back unconditionally
        // on null is safe — recent ECMP disagreement implies >=2 identities
        // in full history, which refuses on its own.
        if (resolvedHost === null) resolvedHost = soleIdentityAtTtl(ttl);
        if (resolvedHost === null) continue;

        const existingId = nodeByTtlHost.get(`${ttl}:${resolvedHost}`);
        const existingNode = existingId !== undefined ? nodeById.get(existingId) : undefined;
        if (existingId !== undefined && existingId !== staleNode.id && existingNode) {
          if (existingNode.active) {
            resolvedAwayNodeIds.add(staleNode.id);
          } else {
            // Coincides with another kept STALE node rather than the
            // live active one, so the live edges don't already cover
            // it — keep this as its own box (merging it into the
            // other node's edges risks ambiguous duplication), but
            // still label it with the resolved identity instead of a
            // bare "???" now that it's known. Leave nodeByTtlHost's
            // `${ttl}:${resolvedHost}` entry pointed at the other,
            // already-registered node — that key already has an
            // owner.
            const nodeEntry = nodeById.get(staleNode.id);
            if (nodeEntry) {
              nodeEntry.host = resolvedHost;
              nodeEntry.inferred = true;
            }
          }
        } else if (existingId === undefined) {
          const nodeEntry = nodeById.get(staleNode.id);
          if (nodeEntry) {
            nodeEntry.host = resolvedHost;
            nodeEntry.inferred = true;
          }
          nodeByTtlHost.set(`${ttl}:${resolvedHost}`, staleNode.id);
        }
      }
    }

    // The live path itself can be showing "???" at a ttl — the steady state
    // for a router that rarely answers probes. When identity inference
    // (recent window first, then the full-history sole-identity fallback)
    // can name it, the active node is relabeled in place. Display-only:
    // rawHost keeps the literal "???" so deviation history and the timeline
    // scrubber still match what was actually recorded. A kept stale twin
    // already carrying that identity at this ttl becomes redundant — its
    // dashed edges would connect the exact neighbors the live edges already
    // connect — so it is dropped, and ${ttl}:${host} lookups repoint to the
    // surviving active node so later stale-edge resolution never references
    // the dropped twin.
    for (const [ttl, activeRow] of activeByTtl) {
      // No ttl floor — same reasoning as the stale loop above: ttl 1's
      // left bound is the source, handled by the fallback.
      if (activeRow.host !== NO_REPLY_HOST) continue;

      let resolvedHost: string | null = null;
      const latestSightingRunId = (
        lastActiveRunStmt.get(targetId, ttl, activeRow.host) as { runId: number | null }
      ).runId;
      if (latestSightingRunId !== null) {
        const left = findRealBoundTtl(latestSightingRunId, ttl, -1);
        const right = findRealBoundTtl(latestSightingRunId, ttl, 1);
        if (left && right && isRealHost(left.host) && isRealHost(right.host)) {
          const bridge = this.bridgeInference.findExactBridge(
            targetId,
            left.host,
            right.host,
            right.ttl - left.ttl - 1,
            1,
          );
          if (bridge) resolvedHost = bridge[ttl - left.ttl - 1];
        }
      }
      if (resolvedHost === null) resolvedHost = soleIdentityAtTtl(ttl);
      if (resolvedHost === null) continue;

      const twinId = nodeByTtlHost.get(`${ttl}:${resolvedHost}`);
      if (twinId !== undefined && twinId !== activeRow.id) {
        resolvedAwayNodeIds.add(twinId);
      }
      const nodeEntry = nodeById.get(activeRow.id);
      if (nodeEntry) {
        nodeEntry.host = resolvedHost;
        nodeEntry.inferred = true;
      }
      nodeByTtlHost.set(`${ttl}:${resolvedHost}`, activeRow.id);
    }

    for (const [ttl, rows] of staleByTtl) {
      const kept = rows.filter((r) => keptStaleIds.has(r.id) && !resolvedAwayNodeIds.has(r.id));
      for (const staleNode of kept) {
        const lastActiveRunId = (
          lastActiveRunStmt.get(targetId, ttl, staleNode.host) as { runId: number | null }
        ).runId;

        let prevSourceId: number | string | undefined;
        if (ttl === 1) {
          prevSourceId = 0;
        } else if (lastActiveRunId !== null) {
          const prevHop = hopAtTtlStmt.get(lastActiveRunId, ttl - 1) as
            | { host: string }
            | undefined;
          if (prevHop?.host === NO_REPLY_HOST) {
            prevSourceId = resolveThroughGap(lastActiveRunId, ttl, staleNode.host, -1);
          } else if (prevHop) {
            prevSourceId = nodeByTtlHost.get(`${ttl - 1}:${prevHop.host}`);
          }
        }
        if (prevSourceId !== undefined) connectStale(prevSourceId, staleNode.id);

        let nextTargetId: number | string | undefined;
        if (lastActiveRunId !== null) {
          const nextHop = hopAtTtlStmt.get(lastActiveRunId, ttl + 1) as
            | { host: string }
            | undefined;
          if (nextHop?.host === NO_REPLY_HOST) {
            nextTargetId = resolveThroughGap(lastActiveRunId, ttl, staleNode.host, 1);
          } else if (nextHop) {
            nextTargetId = nodeByTtlHost.get(`${ttl + 1}:${nextHop.host}`);
          }
        }
        if (nextTargetId !== undefined) connectStale(staleNode.id, nextTargetId);
      }
    }

    nodes.push(...syntheticNodesById.values());
    nodes.push(...inferredNodesById.values());

    return {
      nodes: nodes.filter((n) => !resolvedAwayNodeIds.has(n.id)),
      edges,
    };
  }
}
