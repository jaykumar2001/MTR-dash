import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { HopNode, type HopNodeData } from './HopNode.js';
import { MetricEdge, type MetricEdgeData } from './MetricEdge.js';
import { Legend } from './Legend.js';
import { Copyable } from './Copyable.js';
import { api } from '../api/client.js';
import { separateBoxes } from '../lib/separation.js';
import { computeAutoLayout } from '../lib/layout.js';
import { loadViewport, saveViewport } from '../lib/viewport.js';
import type { MapResult, WhoisResult, WhoisSummary, GeoipSummary } from '../types.js';

const nodeTypes = { hopNode: HopNode };
const edgeTypes = { metricEdge: MetricEdge };
const SOURCE_NODE_ID = 'source';

// Mirrors backend/src/routes/whois.ts's VALID_HOST — hosts that fail this
// were never a real IP/hostname to begin with (mtr's "???" no-reply
// sentinel, or a synthetic gap node sharing that same host string), so
// there's nothing to look up and no error to report.
const LOOKUPABLE_HOST = /^[a-zA-Z0-9.:_-]{1,255}$/;

export function isPersistableNodeId(id: string): boolean {
  return id !== SOURCE_NODE_ID && Number.isFinite(Number(id));
}

// Must stay >= the CSS-rendered footprint of a .hop-node (see styles.css:
// fixed width plus padding/border) so the collision check below is accurate.
const NODE_WIDTH = 170;
const NODE_HEIGHT = 64;
const NODE_GAP = 20;

const EDGE_TABLE_WIDTH_ESTIMATE = 200;
const EDGE_TABLE_HEIGHT_ESTIMATE = 220;
const WHOIS_TABLE_WIDTH_ESTIMATE = 280;
const WHOIS_TABLE_HEIGHT_ESTIMATE = 320;

// Rough IPv4/IPv6 shape check (with optional CIDR suffix), used only to
// decide which whois field values get a copy-on-click affordance.
const IP_LIKE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F]*:[0-9a-fA-F:]+(\/\d{1,3})?$/;
function looksLikeIp(value: string): boolean {
  return IP_LIKE.test(value.trim());
}

/**
 * Nodes never overlap: any pair of node boxes that intersect are pushed apart
 * along their axis of least penetration (minimum-translation-vector), the
 * minimum distance needed to clear each other plus NODE_GAP. Unlike a
 * directional push, this resolves overlap regardless of which axis it's on —
 * including the arrangement a user reaches by dragging nodes around freely.
 */
function resolveOverlaps(nodes: Node[]): Node[] {
  const boxes = nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));
  const displacements = separateBoxes(boxes, { margin: NODE_GAP });
  if (displacements.size === 0) return nodes;
  return nodes.map((node) => {
    const d = displacements.get(node.id);
    if (!d) return node;
    return { ...node, position: { x: node.position.x + d.dx, y: node.position.y + d.dy } };
  });
}

// Keeps a popup as close to the cursor as possible, pulling it back just
// enough to stay fully inside the viewport near an edge — a min/max clamp
// rather than flipping to the opposite side of the cursor.
function clampToViewport(clientX: number, clientY: number, width: number, height: number) {
  const left = Math.min(clientX + 12, window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(clientY + 12, window.innerHeight - height - 8));
  return { left, top };
}

interface NetworkMapProps {
  targetId: number;
  mapData: MapResult;
  historyActive?: { ttl: number; host: string }[] | null;
}

type Popup =
  | { kind: 'edge'; edgeId: string; clientX: number; clientY: number }
  | { kind: 'node'; host: string; clientX: number; clientY: number };

type WhoisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; result: WhoisResult }
  | { status: 'error'; message: string };

/**
 * Owns the viewport when data or the selected target changes. Rendered as a
 * child of <ReactFlow>: useReactFlow() reads context ReactFlow provides to
 * its own children; a sibling-level call in NetworkMap itself can't see that
 * context.
 *
 * Two behaviors, both deferring to a browser-persisted viewport (see
 * lib/viewport.ts) so a zoom/pan the user chose is never reset out from
 * under them:
 * - On target switch, restore that target's saved viewport if one exists.
 * - Whenever `nodes` changes (initial load and every later data update),
 *   re-fit the view to contain every node so hops never spill off screen as
 *   the path grows — but only while the user hasn't chosen their own
 *   viewport for this target; once they have, it wins over auto-fit.
 */
function ViewportController({ targetId, nodes }: { targetId: number; nodes: Node[] }) {
  const { fitView, setViewport } = useReactFlow();

  useEffect(() => {
    const saved = loadViewport(targetId);
    // No `duration` (instant jump), same reasoning as fitView below.
    if (saved) void setViewport(saved);
  }, [targetId, setViewport]);

  useEffect(() => {
    if (nodes.length === 0 || loadViewport(targetId) !== null) return;
    // No `duration`: an animated transition runs through d3-zoom's real pan/
    // zoom gesture pipeline, which fires the same onMoveStart/onMoveEnd
    // events a genuine user drag would — and this component treats those as
    // "the user is interacting with the canvas, dismiss any open popup".
    // An instant (duration-less) fitView updates the transform directly
    // instead, so it never fires those events or dismisses a popup that was
    // just opened by the same interaction that triggered this refit.
    fitView({ padding: 0.15 });
  }, [nodes, targetId, fitView]);
  return null;
}

export function NetworkMap({ targetId, mapData, historyActive }: NetworkMapProps) {
  const isHistoricallyActive = useCallback(
    (ttl: number, host: string) =>
      (historyActive ?? []).some((h) => h.ttl === ttl && h.host === host),
    [historyActive],
  );

  // Lazily loads netname+country for every hop currently on the map, in the
  // background — nodes render immediately with whatever's already known,
  // then pick up netname/flag once the (server-cached) bulk lookup resolves.
  // A ref (not state) tracks which hosts have already been requested, so
  // this never re-fetches a host it's already asked for, without needing
  // `whoisSummaries` itself in the effect's dependency array (which would
  // otherwise re-trigger every time a fetch completes).
  const [whoisSummaries, setWhoisSummaries] = useState<Record<string, WhoisSummary>>({});
  const requestedHostsRef = useRef(new Set<string>());

  const uniqueHosts = useMemo(
    () => Array.from(new Set(mapData.nodes.map((n) => n.host))),
    [mapData.nodes],
  );

  useEffect(() => {
    const newHosts = uniqueHosts.filter((host) => !requestedHostsRef.current.has(host));
    if (newHosts.length === 0) return;
    newHosts.forEach((host) => requestedHostsRef.current.add(host));
    api
      .getWhoisBulk(newHosts)
      .then((summaries) => setWhoisSummaries((prev) => ({ ...prev, ...summaries })))
      .catch(() => {
        // Total batch failure (not a per-host lookup failure, which the
        // backend already absorbs into a null summary) — allow a retry on
        // the next mapData change instead of permanently giving up.
        newHosts.forEach((host) => requestedHostsRef.current.delete(host));
      });
  }, [uniqueHosts]);

  // Lazily loads a reverse-DNS hostname for every hop IP currently on the
  // map, same fetch-once-per-host strategy as whoisSummaries above (mtr now
  // runs with -n, so `host` is always a raw IP — this is the only source of
  // a human-readable name for a hop).
  const [dnsHostnames, setDnsHostnames] = useState<Record<string, string | null>>({});
  const requestedDnsHostsRef = useRef(new Set<string>());

  useEffect(() => {
    const newHosts = uniqueHosts.filter((host) => !requestedDnsHostsRef.current.has(host));
    if (newHosts.length === 0) return;
    newHosts.forEach((host) => requestedDnsHostsRef.current.add(host));
    api
      .getDnsBulk(newHosts)
      .then((hostnames) => setDnsHostnames((prev) => ({ ...prev, ...hostnames })))
      .catch(() => {
        newHosts.forEach((host) => requestedDnsHostsRef.current.delete(host));
      });
  }, [uniqueHosts]);

  // Lazily loads country+city for every hop currently on the map — same
  // fetch-once-per-host strategy as whoisSummaries/dnsHostnames above, but
  // a fully separate data source and cache (GeoIP location vs. WHOIS
  // ownership are deliberately not correlated; see backend/src/services/geoip.ts).
  const [geoipSummaries, setGeoipSummaries] = useState<Record<string, GeoipSummary>>({});
  const requestedGeoipHostsRef = useRef(new Set<string>());

  useEffect(() => {
    const newHosts = uniqueHosts.filter((host) => !requestedGeoipHostsRef.current.has(host));
    if (newHosts.length === 0) return;
    newHosts.forEach((host) => requestedGeoipHostsRef.current.add(host));
    api
      .getGeoipBulk(newHosts)
      .then((summaries) => setGeoipSummaries((prev) => ({ ...prev, ...summaries })))
      .catch(() => {
        newHosts.forEach((host) => requestedGeoipHostsRef.current.delete(host));
      });
  }, [uniqueHosts]);

  // Built from the live (non-stale) edges only — a stale connector edge's
  // `latest` metrics describe a historical poll, not "how far this ttl
  // currently is," so it's not a meaningful input to today's default layout.
  const avgLatencyMsByTtl = useMemo(() => {
    const ttlById = new Map<string, number>();
    for (const n of mapData.nodes) ttlById.set(String(n.id), n.ttl);
    const byTtl = new Map<number, number>();
    for (const e of mapData.edges) {
      if (e.stale || e.latest == null) continue;
      const ttl = ttlById.get(String(e.target));
      if (ttl != null) byTtl.set(ttl, e.latest.avg);
    }
    return byTtl;
  }, [mapData.nodes, mapData.edges]);

  const initialNodes = useMemo<Node[]>(() => {
    // Providing `measured` and `handles` up front means React Flow can compute
    // edge/handle geometry immediately instead of waiting for a ResizeObserver
    // pass over each node and each <Handle> — avoids a one-frame flash of
    // un-routed edges on first paint (and, incidentally, is what makes edges
    // renderable at all in a jsdom test environment, which has no real layout).
    const measured = { width: NODE_WIDTH, height: NODE_HEIGHT };
    const handles = [
      { type: 'target' as const, position: Position.Left, x: 0, y: NODE_HEIGHT / 2 },
      { type: 'source' as const, position: Position.Right, x: NODE_WIDTH, y: NODE_HEIGHT / 2 },
    ];
    const sourceNode: Node = {
      id: SOURCE_NODE_ID,
      type: 'hopNode',
      position: { x: -220, y: 0 },
      data: { host: 'this host', ttl: 0, active: true },
      measured,
      handles,
    };
    const autoPositions = computeAutoLayout(
      mapData.nodes.map((n) => ({ id: String(n.id), ttl: n.ttl, active: n.active })),
      avgLatencyMsByTtl,
      { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, nodeGap: NODE_GAP },
    );
    const hopNodes: Node[] = mapData.nodes.map((n) => {
      const id = String(n.id);
      const position = n.hasCustomPosition
        ? { x: n.x, y: n.y }
        : (autoPositions.get(id) ?? { x: n.x, y: n.y });
      return {
        id,
        type: 'hopNode',
        position,
        measured,
        handles,
        data: {
          host: n.host,
          ttl: n.ttl,
          active:
            historyActive != null
              ? isHistoricallyActive(n.ttl, n.rawHost ?? n.host)
              : n.active,
          inferred: n.inferred,
        },
      };
    });
    return resolveOverlaps([sourceNode, ...hopNodes]);
    // Deliberately NOT keyed on whoisSummaries: this feeds nodeActiveById ->
    // initialEdges -> the effect that clears any open popup when edges
    // change. Coupling whois data into this memo would re-trigger that whole
    // chain (and FitViewOnChange's refit) every time a lazy whois summary
    // resolves, wiping out a just-opened popup — see displayNodes below,
    // which layers netname/country on afterward without touching this.
  }, [mapData.nodes, avgLatencyMsByTtl, historyActive, isHistoricallyActive]);

  // Adds netname (from whois) and country/city (from geoip) on top of
  // initialNodes for rendering only, once their respective bulk summaries
  // arrive. Kept separate from initialNodes (see above) so this never
  // feeds nodeActiveById/initialEdges/FitViewOnChange.
  const displayNodes = useMemo<Node[]>(
    () =>
      initialNodes.map((node) => {
        const host = (node.data as { host: string }).host;
        const summary = whoisSummaries[host];
        const geo = geoipSummaries[host];
        return {
          ...node,
          data: {
            ...node.data,
            netname: summary?.netname ?? null,
            country: geo?.country ?? null,
            city: geo?.city ?? null,
            resolvedHost: dnsHostnames[host] ?? null,
          },
        };
      }),
    [initialNodes, whoisSummaries, geoipSummaries, dnsHostnames],
  );

  const nodeActiveById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const node of initialNodes) {
      map.set(node.id, (node.data as { active: boolean }).active);
    }
    return map;
  }, [initialNodes]);

  const initialEdges = useMemo<Edge[]>(
    () =>
      mapData.edges
        .map((e) => {
          const sourceNodeId = e.source === 0 ? SOURCE_NODE_ID : String(e.source);
          const targetNodeId = String(e.target);
          const active =
            historyActive != null
              ? (nodeActiveById.get(sourceNodeId) ?? false) &&
                (nodeActiveById.get(targetNodeId) ?? false)
              : true;
          return {
            id: e.id,
            source: sourceNodeId,
            target: targetNodeId,
            type: 'metricEdge',
            data: { color: e.color, latest: e.latest, active, stale: e.stale },
          };
        }),
    [mapData.edges, historyActive, nodeActiveById],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(displayNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [whois, setWhois] = useState<WhoisState>({ status: 'idle' });

  useEffect(() => {
    setNodes(displayNodes);
  }, [displayNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
    setPopup(null);
  }, [initialEdges, setEdges]);

  const handleNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      if (!isPersistableNodeId(node.id)) return;
      void api.setNodePosition(targetId, Number(node.id), node.position.x, node.position.y);
    },
    [targetId],
  );

  const handleEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    if ((edge.data as MetricEdgeData).stale) return;
    setPopup((current) =>
      current?.kind === 'edge' && current.edgeId === edge.id
        ? null
        : { kind: 'edge', edgeId: edge.id, clientX: event.clientX, clientY: event.clientY },
    );
  }, []);

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.stopPropagation();
      if (node.id === SOURCE_NODE_ID) {
        setPopup(null);
        return;
      }
      const { host } = node.data as HopNodeData;
      if (popup?.kind === 'node' && popup.host === host) {
        setPopup(null);
        return;
      }
      setPopup({ kind: 'node', host, clientX: event.clientX, clientY: event.clientY });
      if (!LOOKUPABLE_HOST.test(host)) {
        setWhois({ status: 'success', result: { host, fields: [] } });
        return;
      }
      setWhois({ status: 'loading' });
      api
        .getWhois(host)
        .then((result) => setWhois({ status: 'success', result }))
        .catch((err) =>
          setWhois({
            status: 'error',
            message: err instanceof Error ? err.message : 'Lookup failed',
          }),
        );
    },
    [popup],
  );

  // Hover state driving path-wide highlighting (see pathHighlight below).
  // Deliberately a single `{kind, id} | null` rather than separate
  // node/edge fields — only one element can be hovered at a time, and this
  // shape makes "nothing is hovered" a single, unambiguous `null` check.
  const [hoveredElement, setHoveredElement] = useState<
    { kind: 'node' | 'edge'; id: string } | null
  >(null);

  const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: Node) => {
    setHoveredElement({ kind: 'node', id: node.id });
  }, []);

  // Guarded the same way handleNodeClick/handleEdgeClick already guard
  // against stale state: only clear if the element being left is still the
  // one currently tracked as hovered, so a fast pointer move from node A
  // straight onto node B can never have A's leave event clear B's just-set
  // hover.
  const handleNodeMouseLeave = useCallback((_event: React.MouseEvent, node: Node) => {
    setHoveredElement((current) =>
      current?.kind === 'node' && current.id === node.id ? null : current,
    );
  }, []);

  const handleEdgeMouseEnter = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setHoveredElement({ kind: 'edge', id: edge.id });
  }, []);

  const handleEdgeMouseLeave = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setHoveredElement((current) =>
      current?.kind === 'edge' && current.id === edge.id ? null : current,
    );
  }, []);

  // Two DIRECTIONAL walks over the currently-rendered edge graph, not one
  // undirected BFS: the graph is fully connected (every hop traces back to
  // the same origin), so a plain "visit any neighbor, either direction"
  // flood-fill from any starting point always reaches every node on the
  // map, regardless of which element was hovered — it can never dim
  // anything. Walking ancestors and descendants as two separate passes,
  // each following only its own direction, is what actually confines the
  // highlight to the hovered element's own route instead of leaking into
  // unrelated sibling branches (e.g. a stale connector hanging off the
  // same ancestor as the active chain).
  //
  // - Ancestors: from the start point, repeatedly take the edge(s) whose
  //   TARGET is the current node, moving to their SOURCE. Never explores
  //   an ancestor's other children — only the single path upward.
  // - Descendants: from the start point, repeatedly take the edge(s) whose
  //   SOURCE is the current node, moving to their TARGET. A node can have
  //   more than one outgoing edge (a shared historical neighbor for
  //   multiple since-diverged stale segments) — every branch downward from
  //   the hovered element is included, which is intentional.
  //
  // For a hovered NODE, both walks start at that node. For a hovered EDGE,
  // the ancestor walk starts at its `source` endpoint and the descendant
  // walk starts at its `target` endpoint — never both directions from both
  // endpoints, which would (again) leak into the source endpoint's other
  // children.
  const pathHighlight = useMemo(() => {
    if (!hoveredElement) return null;

    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    let ancestorStart: string;
    let descendantStart: string;

    if (hoveredElement.kind === 'node') {
      ancestorStart = hoveredElement.id;
      descendantStart = hoveredElement.id;
      nodeIds.add(hoveredElement.id);
    } else {
      const edge = edges.find((e) => e.id === hoveredElement.id);
      if (!edge) return null;
      ancestorStart = edge.source;
      descendantStart = edge.target;
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      edgeIds.add(edge.id);
    }

    const ancestorQueue = [ancestorStart];
    while (ancestorQueue.length > 0) {
      const current = ancestorQueue.shift() as string;
      for (const edge of edges) {
        if (edge.target !== current) continue;
        edgeIds.add(edge.id);
        if (!nodeIds.has(edge.source)) {
          nodeIds.add(edge.source);
          ancestorQueue.push(edge.source);
        }
      }
    }

    const descendantQueue = [descendantStart];
    while (descendantQueue.length > 0) {
      const current = descendantQueue.shift() as string;
      for (const edge of edges) {
        if (edge.source !== current) continue;
        edgeIds.add(edge.id);
        if (!nodeIds.has(edge.target)) {
          nodeIds.add(edge.target);
          descendantQueue.push(edge.target);
        }
      }
    }

    return { nodeIds, edgeIds };
  }, [hoveredElement, edges]);

  // Render-time-only layer, same reasoning as displayNodes above: adding
  // `dimmed` here (rather than into the `nodes`/`edges` state itself) means
  // a hover — which fires far more often than a click — never touches the
  // position/selection-carrying state or retriggers the effects keyed on
  // it. `renderedNodes`/`renderedEdges`, not `nodes`/`edges`, are what
  // actually get passed to <ReactFlow>.
  const renderedNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          dimmed: pathHighlight !== null && !pathHighlight.nodeIds.has(node.id),
        },
      })),
    [nodes, pathHighlight],
  );

  const renderedEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          dimmed: pathHighlight !== null && !pathHighlight.edgeIds.has(edge.id),
        },
      })),
    [edges, pathHighlight],
  );

  const dismissPopup = useCallback(() => setPopup(null), []);

  // `fitView()` (called both on mount and by FitViewOnChange) moves the
  // viewport through the same d3-zoom transform API a real user drag/pinch
  // does, so it fires this same onMoveStart event — but with `event: null`,
  // since there's no real pointer gesture behind it. Only a genuine user
  // pan/zoom (a non-null event) should dismiss an open popup; otherwise our
  // own programmatic re-fit would wipe out the popup the same click just opened.
  const handleMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event !== null) setPopup(null);
  }, []);

  // Same non-null-event test as handleMoveStart: only a genuine user
  // pan/zoom gesture persists the viewport — a programmatic fitView/
  // setViewport (null event) must not overwrite what the user chose.
  const handleMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      if (event !== null) saveViewport(targetId, viewport);
    },
    [targetId],
  );

  // Mount-time viewport: restore this target's saved viewport if one exists,
  // otherwise fall back to React Flow's own pre-paint fitView. Read once —
  // later target switches (no remount) are ViewportController's job.
  const [initialViewport] = useState(() => loadViewport(targetId));

  const clickedEdgeMetrics = useMemo(() => {
    if (popup?.kind !== 'edge') return null;
    const edge = edges.find((e) => e.id === popup.edgeId);
    return edge ? (edge.data as MetricEdgeData) : null;
  }, [popup, edges]);

  return (
    <div className="network-map">
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onPaneClick={dismissPopup}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        minZoom={0.1}
        fitView={initialViewport === null}
        fitViewOptions={{ padding: 0.15 }}
        defaultViewport={initialViewport ?? undefined}
      >
        <Background color="#3a362e" gap={28} size={1} />
        <Controls />
        {/* Keyed on the memoized `initialNodes` (derived only from mapData/
            historyActive), not the live `nodes` state — the latter also
            changes on every click/select/drag, which would refire fitView
            and its real viewport transition on every interaction, firing
            onMoveStart and wiping out whatever popup the same click just
            opened. */}
        <ViewportController targetId={targetId} nodes={initialNodes} />
      </ReactFlow>
      <Legend />
      {popup?.kind === 'edge' && clickedEdgeMetrics?.latest && (
        <table
          className="edge-metrics-table"
          style={clampToViewport(
            popup.clientX,
            popup.clientY,
            EDGE_TABLE_WIDTH_ESTIMATE,
            EDGE_TABLE_HEIGHT_ESTIMATE,
          )}
        >
          <tbody>
            <tr>
              <th>Loss</th>
              <td>{clickedEdgeMetrics.latest.lossPct}%</td>
            </tr>
            <tr>
              <th>Snt</th>
              <td>{clickedEdgeMetrics.latest.snt}</td>
            </tr>
            <tr>
              <th>Last</th>
              <td>{clickedEdgeMetrics.latest.last}</td>
            </tr>
            <tr>
              <th>Avg</th>
              <td>{clickedEdgeMetrics.latest.avg}</td>
            </tr>
            <tr>
              <th>Best</th>
              <td>{clickedEdgeMetrics.latest.best}</td>
            </tr>
            <tr>
              <th>Wrst</th>
              <td>{clickedEdgeMetrics.latest.wrst}</td>
            </tr>
            <tr>
              <th>StDev</th>
              <td>{clickedEdgeMetrics.latest.stdev}</td>
            </tr>
          </tbody>
        </table>
      )}
      {popup?.kind === 'node' && (
        <div
          className="node-whois-table"
          style={clampToViewport(
            popup.clientX,
            popup.clientY,
            WHOIS_TABLE_WIDTH_ESTIMATE,
            WHOIS_TABLE_HEIGHT_ESTIMATE,
          )}
        >
          <div className="node-whois-header">
            <Copyable text={popup.host} />
          </div>
          <div className="node-whois-body">
            {whois.status === 'loading' && (
              <div className="node-whois-status">Looking up whois…</div>
            )}
            {whois.status === 'error' && (
              <div className="node-whois-status error">Whois lookup failed: {whois.message}</div>
            )}
            {whois.status === 'success' &&
              (whois.result.fields.length === 0 ? (
                <div className="node-whois-status">No whois data available</div>
              ) : (
                <table>
                  <tbody>
                    {whois.result.fields.map((field, i) => (
                      <tr key={i}>
                        <th>{field.key}</th>
                        <td>
                          {looksLikeIp(field.value) ? (
                            <Copyable text={field.value} />
                          ) : (
                            field.value
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
