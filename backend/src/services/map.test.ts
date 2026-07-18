import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { RunsService } from './runs.js';
import { MapService } from './map.js';
import { PositionsService } from './positions.js';
import type { MtrReport } from '../mtr/types.js';

function reportWithLoss(hops: { ttl: number; host: string; lossPct: number }[]): MtrReport {
  return {
    target: '1.1.1.1',
    hops: hops.map((h) => ({
      ttl: h.ttl,
      host: h.host,
      lossPct: h.lossPct,
      snt: 10,
      last: 1,
      avg: 1,
      best: 1,
      wrst: 1,
      stdev: 0,
    })),
  };
}

describe('MapService', () => {
  let db: Database.Database;
  let runs: RunsService;
  let map: MapService;
  let targetId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runs = new RunsService(db);
    map = new MapService(db);
    const result = db.prepare('INSERT INTO targets (host) VALUES (?)').run('1.1.1.1');
    targetId = result.lastInsertRowid as number;
  });

  it('returns one node per active hop and edges linking them in ttl order', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].source).toBe(0);
    expect(result.edges[1].source).toBe(result.edges[0].target);
  });

  it('flags a node with a saved position as hasCustomPosition, and one without as not', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const before = map.getMap(targetId);
    const nodeABefore = before.nodes.find((n) => n.host === 'A')!;
    const nodeBBefore = before.nodes.find((n) => n.host === 'B')!;
    expect(nodeABefore.hasCustomPosition).toBe(false);
    expect(nodeBBefore.hasCustomPosition).toBe(false);

    new PositionsService(db).setPosition(targetId, nodeABefore.id as number, 555, 666);

    const after = map.getMap(targetId);
    const nodeAAfter = after.nodes.find((n) => n.host === 'A')!;
    const nodeBAfter = after.nodes.find((n) => n.host === 'B')!;
    expect(nodeAAfter.hasCustomPosition).toBe(true);
    expect(nodeAAfter.x).toBe(555);
    expect(nodeAAfter.y).toBe(666);
    expect(nodeBAfter.hasCustomPosition).toBe(false);
  });

  it('always flags a synthetic gap node as hasCustomPosition: false', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );

    const result = map.getMap(targetId);
    const synthNode = result.nodes.find((n) => typeof n.id === 'string')!;
    expect(synthNode.hasCustomPosition).toBe(false);
  });

  it('colors an edge green when average loss over recent runs is 0', () => {
    for (let i = 0; i < 3; i++) {
      runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    }
    const result = map.getMap(targetId);
    expect(result.edges[0].color).toBe('green');
  });

  it('colors an edge red when average loss over the last 5 runs exceeds 5%', () => {
    for (let i = 0; i < 5; i++) {
      runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 20 }]));
    }
    const result = map.getMap(targetId);
    expect(result.edges[0].color).toBe('red');
    expect(result.edges[0].avgLossPct).toBe(20);
  });

  it('includes inactive nodes after a deviation', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    expect(result.nodes).toHaveLength(2);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    expect(nodeA.active).toBe(false);
  });

  it('connects a stale node to the current active neighbors at ttl-1 and ttl+1', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'X', lossPct: 0 },
        { ttl: 3, host: 'Z', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Y', lossPct: 0 },
        { ttl: 3, host: 'Z', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    const nodeZ = result.nodes.find((n) => n.host === 'Z')!;
    expect(nodeX.active).toBe(false);

    const inEdge = result.edges.find((e) => e.target === nodeX.id && e.stale);
    const outEdge = result.edges.find((e) => e.source === nodeX.id && e.stale);
    expect(inEdge?.source).toBe(nodeA.id);
    expect(outEdge?.target).toBe(nodeZ.id);
    expect(inEdge?.color).toBe('grey');
    expect(inEdge?.avgLossPct).toBeUndefined();
    expect(inEdge?.latest).toBeUndefined();
  });

  it('connects a stale ttl=1 node to the synthetic source', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const staleEdge = result.edges.find((e) => e.target === nodeA.id && e.stale);
    expect(staleEdge?.source).toBe(0);
  });

  it('limits stale nodes per ttl to maxStaleHops, keeping the most recently deactivated', () => {
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'C', lossPct: 0 }]));

    const result = map.getMap(targetId);
    const hosts = result.nodes.map((n) => n.host);
    expect(hosts).toContain('C');
    expect(hosts).toContain('B');
    expect(hosts).not.toContain('A');
  });

  it('omits stale nodes and edges entirely when maxStaleHops is 0', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 0 WHERE id = ?').run(targetId);
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'A', lossPct: 0 }]));
    runs.ingest(targetId, reportWithLoss([{ ttl: 1, host: 'B', lossPct: 0 }]));

    const result = map.getMap(targetId);
    expect(result.nodes.map((n) => n.host)).toEqual(['B']);
    expect(result.edges.every((e) => !e.stale)).toBe(true);
  });

  it('leaves a mid-path stale node without edges when neither ttl neighbor has an active node', () => {
    runs.ingest(targetId, reportWithLoss([
      { ttl: 1, host: 'A', lossPct: 0 },
      { ttl: 3, host: 'X', lossPct: 0 },
    ]));
    runs.ingest(targetId, reportWithLoss([
      { ttl: 1, host: 'A', lossPct: 0 },
      { ttl: 3, host: 'Y', lossPct: 0 },
    ]));

    const result = map.getMap(targetId);
    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    expect(nodeX.active).toBe(false);
    expect(result.edges.some((e) => e.stale && (e.source === nodeX.id || e.target === nodeX.id))).toBe(false);
  });

  it('connects two simultaneously-retained stale nodes at the same ttl, each to the active neighbors', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 2 WHERE id = ?').run(targetId);
    runs.ingest(targetId, reportWithLoss([
      { ttl: 1, host: 'A', lossPct: 0 },
      { ttl: 2, host: 'X', lossPct: 0 },
      { ttl: 3, host: 'Z', lossPct: 0 },
    ]));
    runs.ingest(targetId, reportWithLoss([
      { ttl: 1, host: 'A', lossPct: 0 },
      { ttl: 2, host: 'Y', lossPct: 0 },
      { ttl: 3, host: 'Z', lossPct: 0 },
    ]));
    runs.ingest(targetId, reportWithLoss([
      { ttl: 1, host: 'A', lossPct: 0 },
      { ttl: 2, host: 'W', lossPct: 0 },
      { ttl: 3, host: 'Z', lossPct: 0 },
    ]));

    const result = map.getMap(targetId);
    const hosts = result.nodes.map((n) => n.host);
    expect(hosts).toEqual(expect.arrayContaining(['A', 'X', 'Y', 'W', 'Z']));

    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    const nodeY = result.nodes.find((n) => n.host === 'Y')!;
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeZ = result.nodes.find((n) => n.host === 'Z')!;

    for (const stale of [nodeX, nodeY]) {
      const inEdge = result.edges.find((e) => e.stale && e.target === stale.id);
      const outEdge = result.edges.find((e) => e.stale && e.source === stale.id);
      expect(inEdge?.source).toBe(nodeA.id);
      expect(outEdge?.target).toBe(nodeZ.id);
    }
  });

  it('connects two correlated stale nodes to each other, not to unrelated live nodes, when adjacent hops change together', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: 'C2', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeB = result.nodes.find((n) => n.host === 'B')!;
    const nodeC = result.nodes.find((n) => n.host === 'C')!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;
    const nodeB2 = result.nodes.find((n) => n.host === 'B2')!;
    const nodeC2 = result.nodes.find((n) => n.host === 'C2')!;

    const staleEdges = result.edges.filter((e) => e.stale);
    const staleEdgeIds = staleEdges.map((e) => e.id).sort();
    expect(staleEdgeIds).toEqual(
      [`${nodeA.id}-${nodeB.id}`, `${nodeB.id}-${nodeC.id}`, `${nodeC.id}-${nodeD.id}`].sort(),
    );

    // The stale segment never touches the new live nodes.
    expect(
      staleEdges.some(
        (e) =>
          e.source === nodeB2.id ||
          e.target === nodeB2.id ||
          e.source === nodeC2.id ||
          e.target === nodeC2.id,
      ),
    ).toBe(false);

    const liveEdgeIds = result.edges
      .filter((e) => !e.stale)
      .map((e) => e.id)
      .sort();
    expect(liveEdgeIds).toEqual(
      [
        `0-${nodeA.id}`,
        `${nodeA.id}-${nodeB2.id}`,
        `${nodeB2.id}-${nodeC2.id}`,
        `${nodeC2.id}-${nodeD.id}`,
      ].sort(),
    );
  });

  it("omits a stale node's edge to a neighbor that has since been bumped out of the kept set", () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'P', lossPct: 0 },
        { ttl: 3, host: 'X', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Q', lossPct: 0 },
        { ttl: 3, host: 'Y', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'R', lossPct: 0 },
        { ttl: 3, host: 'Y', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeX = result.nodes.find((n) => n.host === 'X')!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;
    const hosts = result.nodes.map((n) => n.host);
    expect(hosts).not.toContain('P'); // bumped out by maxStaleHops=1 (default) at ttl 2

    const staleEdges = result.edges.filter((e) => e.stale);
    expect(staleEdges.some((e) => e.target === nodeX.id)).toBe(false);
    expect(staleEdges.some((e) => e.source === nodeX.id && e.target === nodeD.id)).toBe(true);
  });

  it('connects a stale node to a distinct synthetic node when its historical neighbor is unresolved (???), not to the live active ??? node', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const liveUnknown = result.nodes.find((n) => n.host === '???' && n.active === true)!;

    const staleOutEdge = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    expect(staleOutEdge.target).not.toBe(liveUnknown.id);

    const syntheticNode = result.nodes.find((n) => n.id === staleOutEdge.target)!;
    expect(syntheticNode.host).toBe('???');
    expect(syntheticNode.active).toBe(false);
    expect(typeof syntheticNode.id).toBe('string');
  });

  it('reuses the same synthetic ??? chain when two stale segments resolve into an identically-bounded gap', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: 'D2', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const staleD = result.nodes.find((n) => n.host === 'D' && n.active === false)!;

    const syntheticNodes = result.nodes.filter((n) => typeof n.id === 'string');
    expect(syntheticNodes).toHaveLength(2);

    const synth3 = syntheticNodes.find((n) => n.ttl === 3)!;
    const synth4 = syntheticNodes.find((n) => n.ttl === 4)!;

    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    const edgeIntoD = result.edges.find((e) => e.stale && e.target === staleD.id)!;
    expect(edgeFromB.target).toBe(synth3.id);
    expect(edgeIntoD.source).toBe(synth4.id);
    expect(
      result.edges.some((e) => e.stale && e.source === synth3.id && e.target === synth4.id),
    ).toBe(true);
  });

  it('does not share a synthetic node across resolutions whose near-bound host differs, even when the far bound matches', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 2 WHERE id = ?').run(targetId);

    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Bolder', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleBolder = result.nodes.find((n) => n.host === 'Bolder')!;
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D')!;

    const edgeFromBolder = result.edges.find((e) => e.stale && e.source === staleBolder.id)!;
    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    expect(edgeFromBolder.target).not.toBe(edgeFromB.target);

    expect(
      result.edges.some(
        (e) => e.stale && e.source === edgeFromBolder.target && e.target === nodeD.id,
      ),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.stale && e.source === edgeFromB.target && e.target === nodeD.id),
    ).toBe(true);
  });

  it("does not use a stale anchor node's own ??? host as a merge-key identity token", () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleUnknownAnchor = result.nodes.find((n) => n.host === '???' && n.active === false)!;

    const edgeFromAnchor = result.edges.find(
      (e) => e.stale && e.source === staleUnknownAnchor.id,
    )!;
    const synthNode = result.nodes.find((n) => n.id === edgeFromAnchor.target)!;

    expect(typeof synthNode.id).toBe('string');
    expect(synthNode.id as string).not.toMatch(/\|\?\?\?\|/);
  });

  it('gives a recurring gap the same synthetic identity across separate occurrences, even when the anchor resolving it is itself a ??? node', () => {
    // ttl1=A and ttl4=D never change. ttl2 flips between '???' and a real
    // host twice, and ttl3 stays '???' throughout — so each time ttl2 goes
    // stale again, it's a *different* historical run (a different
    // lastActiveRunId) resolving the exact same ttl3 gap, bounded by the
    // same A/D. These must produce the same synthetic id both times, or the
    // gap isn't actually being deduplicated across occurrences.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'X', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const firstResult = map.getMap(targetId);
    const firstAnchor = firstResult.nodes.find((n) => n.host === '???' && n.active === false)!;
    const firstEdge = firstResult.edges.find((e) => e.stale && e.source === firstAnchor.id)!;
    const firstSynth = firstResult.nodes.find((n) => n.id === firstEdge.target)!;

    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Z', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const secondResult = map.getMap(targetId);
    const secondAnchor = secondResult.nodes.find((n) => n.host === '???' && n.active === false)!;
    const secondEdge = secondResult.edges.find((e) => e.stale && e.source === secondAnchor.id)!;
    const secondSynth = secondResult.nodes.find((n) => n.id === secondEdge.target)!;

    expect(secondSynth.id).toBe(firstSynth.id);
  });

  it('reuses an existing kept real node instead of creating a duplicate when the resolved host is already tracked', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'X', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const staleX = result.nodes.find((n) => n.host === 'X')!;

    expect(staleX.inferred).toBe(false);
    expect(typeof staleX.id).toBe('number');
    expect(
      result.edges.some((e) => e.stale && e.source === staleB.id && e.target === staleX.id),
    ).toBe(true);
  });

  it('substitutes a specific real identity for a ??? gap when exactly one known bridge connects its bounds', () => {
    // Bridge evidence at an unrelated ttl range, so it never becomes a kept
    // node in its own right — BridgeInferenceService matches purely on host
    // string, not ttl, so it's still found via recent-history lookup.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D' && n.ttl === 4)!;
    const inferredNode = result.nodes.find((n) => n.host === 'X' && n.ttl === 3)!;

    expect(inferredNode).toBeDefined();
    expect(inferredNode.inferred).toBe(true);
    expect(inferredNode.active).toBe(false);
    expect(
      result.edges.some((e) => e.stale && e.source === staleB.id && e.target === inferredNode.id),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.stale && e.source === inferredNode.id && e.target === nodeD.id),
    ).toBe(true);
  });

  it('does not substitute when recent history shows two different real bridges (ECMP-like ambiguity)', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 31, host: 'B', lossPct: 0 },
        { ttl: 32, host: 'Y', lossPct: 0 },
        { ttl: 33, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const edgeFromB = result.edges.find((e) => e.stale && e.source === staleB.id)!;
    const target = result.nodes.find((n) => n.id === edgeFromB.target)!;

    expect(target.host).toBe('???');
    expect(target.inferred).toBe(false);
  });

  it('resolves a known prefix of a longer unresolved run, leaving the true remainder as an anonymous placeholder', () => {
    // Bridge evidence: B is followed by X, Y, then another unknown hop.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'B', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'Y', lossPct: 0 },
        { ttl: 24, host: '???', lossPct: 100 },
      ]),
    );
    // The live path: a 3-hop unresolved run bounded by B and D.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: '???', lossPct: 100 },
        { ttl: 6, host: 'D', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B2', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: '???', lossPct: 100 },
        { ttl: 5, host: '???', lossPct: 100 },
        { ttl: 6, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleB = result.nodes.find((n) => n.host === 'B' && n.active === false)!;
    const nodeD = result.nodes.find((n) => n.host === 'D' && n.ttl === 6)!;
    const inferredX = result.nodes.find((n) => n.host === 'X' && n.ttl === 3)!;
    const inferredY = result.nodes.find((n) => n.host === 'Y' && n.ttl === 4)!;
    const remainder = result.nodes.find((n) => n.host === '???' && n.ttl === 5 && !n.active)!;

    expect(inferredX.inferred).toBe(true);
    expect(inferredY.inferred).toBe(true);
    expect(remainder.inferred).toBe(false);

    const staleEdges = result.edges.filter((e) => e.stale);
    expect(staleEdges.some((e) => e.source === staleB.id && e.target === inferredX.id)).toBe(true);
    expect(staleEdges.some((e) => e.source === inferredX.id && e.target === inferredY.id)).toBe(
      true,
    );
    expect(staleEdges.some((e) => e.source === inferredY.id && e.target === remainder.id)).toBe(
      true,
    );
    expect(staleEdges.some((e) => e.source === remainder.id && e.target === nodeD.id)).toBe(true);
  });

  it("resolves a standalone stale ??? node bounded by two real hosts to the current live path's identity, dropping the redundant unknown box", () => {
    // A -> B -> C, all real and unchanged.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 stops responding, sandwiched directly between A and C (neither changes).
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 responds again with the same host as before it dropped out.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeB = result.nodes.find((n) => n.host === 'B')!;
    const nodeC = result.nodes.find((n) => n.host === 'C')!;

    expect(nodeB.active).toBe(true);
    expect(result.nodes.some((n) => n.host === '???')).toBe(false);

    const liveEdges = result.edges.filter((e) => !e.stale);
    expect(
      liveEdges.filter((e) => e.source === nodeA.id && e.target === nodeB.id),
    ).toHaveLength(1);
    expect(
      liveEdges.filter((e) => e.source === nodeB.id && e.target === nodeC.id),
    ).toHaveLength(1);
    expect(result.edges.some((e) => e.stale)).toBe(false);
  });

  it('relabels a standalone stale ??? node in place when the resolved bridge host has no existing representation on the map', () => {
    // Bridge evidence at an unrelated ttl range: A -> X -> C is the only
    // real sequence ever seen connecting A and C.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'A', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'C', lossPct: 0 },
      ]),
    );
    // Live: A -> ??? -> C, sandwiched directly.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 (and, incidentally, ttl3) deviate — Y is not followed by C, so it
    // is not itself competing bridge evidence for (A, C).
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Y', lossPct: 0 },
        { ttl: 3, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const resolvedNode = result.nodes.find((n) => n.host === 'X')!;

    expect(resolvedNode).toBeDefined();
    expect(resolvedNode.inferred).toBe(true);
    expect(resolvedNode.active).toBe(false);
    expect(typeof resolvedNode.id).toBe('number');

    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeC = result.nodes.find((n) => n.host === 'C' && n.ttl === 3)!;
    expect(
      result.edges.some((e) => e.stale && e.source === nodeA.id && e.target === resolvedNode.id),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.stale && e.source === resolvedNode.id && e.target === nodeC.id),
    ).toBe(true);
  });

  it("resolves a stale ??? node's own identity across a two-hop historical gap, not just its immediate neighbor", () => {
    // A -> B -> C -> D is the only real sequence ever connecting A and D.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    // ttl2 and ttl3 drop out together.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    // ttl2 recovers to B; ttl3 stays '???' (still the live state there), so
    // the stale ttl2 "???" node's own last-active snapshot has a second
    // consecutive unresolved hop right after it, not a real host.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const nodeB = result.nodes.find((n) => n.host === 'B')!;

    expect(nodeB.active).toBe(true);
    // The old ttl2 "???" node resolves to B (the same host now live there)
    // and is dropped as redundant, rather than lingering as a bare "???"
    // forever because its immediate neighbor (ttl3) is itself unresolved.
    expect(result.nodes.some((n) => n.host === '???' && n.active === false)).toBe(false);
  });

  it('labels a resolved stale ??? node with its known identity even when that identity coincides with another kept stale node, instead of leaving it as a bare ???', () => {
    // A -> B -> C is the only real sequence ever connecting A and C.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 drops out, sandwiched directly between A and C.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 recovers to B, then deviates again to D — with maxStaleHops=2,
    // both B (stale, not active) and the earlier "???" (stale, not active)
    // are kept simultaneously at ttl2, so the "???" node's bridge-resolved
    // identity (B) coincides with an existing KEPT STALE node, not the
    // live active one (D).
    db.prepare('UPDATE targets SET max_stale_hops = 2 WHERE id = ?').run(targetId);
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl3 changes too (to E, not C) so this poll doesn't itself become
    // competing bridge evidence for (A, C) — it's irrelevant to this test.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'D', lossPct: 0 },
        { ttl: 3, host: 'E', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const staleNodes = result.nodes.filter((n) => n.ttl === 2 && n.active === false);

    expect(staleNodes.some((n) => n.host === '???')).toBe(false);
    expect(staleNodes.filter((n) => n.host === 'B')).toHaveLength(2);
  });

  it("preserves a relabeled stale node's original raw host for history matching, even though its display host changes", () => {
    // Bridge evidence: A -> X -> C is the only real sequence ever seen
    // connecting A and C.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 21, host: 'A', lossPct: 0 },
        { ttl: 22, host: 'X', lossPct: 0 },
        { ttl: 23, host: 'C', lossPct: 0 },
      ]),
    );
    // Live: A -> ??? -> C, sandwiched directly, with no existing kept
    // representation for X at ttl2 — this triggers the relabel-in-place path.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'Y', lossPct: 0 },
        { ttl: 3, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const resolvedNode = result.nodes.find((n) => n.host === 'X')!;

    expect(resolvedNode).toBeDefined();
    // Display host is the resolved identity, but the raw host recorded for
    // this node's actual poll history is still the literal "???" it really
    // was — deviations were recorded against that raw identity, not "X".
    expect(resolvedNode.rawHost).toBe('???');
  });

  it('resolves a stale ??? node via the long-horizon fallback when its evidence is older than the recent window', () => {
    // Identity evidence: one early run where ttl2=B and ttl3=C both answered
    // — the only real identities ever recorded at those ttls.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );
    // 21 runs with ttl2 AND ttl3 both silent: pushes the evidence run beyond
    // the 20-occurrence window anchored on A, and gives the (future) stale
    // ttl2 "???" node a "???" right-neighbor in its own snapshot, so the
    // windowed walked-bounds bridge needs a 2-hop proof it can't find.
    for (let i = 0; i < 21; i++) {
      runs.ingest(
        targetId,
        reportWithLoss([
          { ttl: 1, host: 'A', lossPct: 0 },
          { ttl: 2, host: '???', lossPct: 100 },
          { ttl: 3, host: '???', lossPct: 100 },
          { ttl: 4, host: 'D', lossPct: 0 },
        ]),
      );
    }
    // ttl2 recovers to B — the old ttl2 "???" goes stale; ttl3 stays "???".
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: '???', lossPct: 100 },
        { ttl: 4, host: 'D', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    // The stale ttl2 "???" resolves to B via full-history unanimity — and B
    // is the live active node there, so the stale box is dropped as
    // redundant rather than lingering as a bare "???" forever.
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    expect(ttl2Nodes[0].host).toBe('B');
    expect(ttl2Nodes[0].active).toBe(true);
  });

  it('relabels an active ??? node with its sole historical identity and drops the redundant stale twin', () => {
    // Evidence: one early run where ttl2 identified as B.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    // ttl2 goes silent and stays silent for 22 runs — far beyond the
    // 20-occurrence window anchored on its ever-responsive neighbors. The
    // live path now shows "???" at ttl2, with stale twin B kept alongside.
    for (let i = 0; i < 22; i++) {
      runs.ingest(
        targetId,
        reportWithLoss([
          { ttl: 1, host: 'A', lossPct: 0 },
          { ttl: 2, host: '???', lossPct: 100 },
          { ttl: 3, host: 'C', lossPct: 0 },
        ]),
      );
    }

    const result = map.getMap(targetId);
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    const merged = ttl2Nodes[0];
    expect(merged.host).toBe('B');
    expect(merged.active).toBe(true);
    expect(merged.inferred).toBe(true);
    expect(merged.rawHost).toBe('???');

    // No dangling edges to the dropped twin; live edges route through the
    // relabeled node with their metrics intact.
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    for (const e of result.edges) {
      if (e.source !== 0) expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
    const nodeA = result.nodes.find((n) => n.host === 'A')!;
    const nodeC = result.nodes.find((n) => n.host === 'C')!;
    expect(
      result.edges.some((e) => !e.stale && e.source === nodeA.id && e.target === merged.id),
    ).toBe(true);
    expect(
      result.edges.some((e) => !e.stale && e.source === merged.id && e.target === nodeC.id),
    ).toBe(true);
  });

  it('does not relabel an active ??? node when a second identity exists anywhere in history', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'X', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const activeTtl2 = result.nodes.find((n) => n.ttl === 2 && n.active)!;
    expect(activeTtl2.host).toBe('???');
    expect(activeTtl2.inferred).toBe(false);
  });

  it('relabels an active ??? node in place when no stale twin exists (maxStaleHops=0)', () => {
    db.prepare('UPDATE targets SET max_stale_hops = 0 WHERE id = ?').run(targetId);
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: '???', lossPct: 100 },
        { ttl: 3, host: 'C', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const ttl2Nodes = result.nodes.filter((n) => n.ttl === 2);
    expect(ttl2Nodes).toHaveLength(1);
    expect(ttl2Nodes[0].host).toBe('B');
    expect(ttl2Nodes[0].active).toBe(true);
    expect(ttl2Nodes[0].inferred).toBe(true);
  });

  it('resolves a stale ??? node at ttl 1 — the source is its known left bound', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );
    // ttl1 briefly goes silent, then recovers to the same host — leaving a
    // stale "???" row at ttl1 whose only bounds are the source and B.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: '???', lossPct: 100 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    // The stale "???" resolves to A — the live active node at ttl1 — and is
    // dropped as redundant.
    const ttl1Nodes = result.nodes.filter((n) => n.ttl === 1);
    expect(ttl1Nodes).toHaveLength(1);
    expect(ttl1Nodes[0].host).toBe('A');
    expect(ttl1Nodes[0].active).toBe(true);
    expect(result.edges.some((e) => e.stale)).toBe(false);
  });

  it('relabels an active ??? node at ttl 1 and drops its stale twin', () => {
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: 'A', lossPct: 0 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );
    // ttl1 goes silent and stays silent — live path shows "???" at ttl1,
    // with stale twin A kept alongside.
    runs.ingest(
      targetId,
      reportWithLoss([
        { ttl: 1, host: '???', lossPct: 100 },
        { ttl: 2, host: 'B', lossPct: 0 },
      ]),
    );

    const result = map.getMap(targetId);
    const ttl1Nodes = result.nodes.filter((n) => n.ttl === 1);
    expect(ttl1Nodes).toHaveLength(1);
    expect(ttl1Nodes[0].host).toBe('A');
    expect(ttl1Nodes[0].active).toBe(true);
    expect(ttl1Nodes[0].inferred).toBe(true);
    expect(ttl1Nodes[0].rawHost).toBe('???');
  });
});
