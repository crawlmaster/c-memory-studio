/**
 * frontend/src/components/Visualizer/GraphVisualizer.tsx
 * Topology-Aware DWARF Graph, Tree, Linear-List, Circular-List & Pointer Mesh Visualizer.
 *
 * Key Capabilities:
 * 1. Optional Interactive Layout Selector (`layoutMode: 'auto' | 'hierarchical' | 'organic' | 'circular'`):
 *    - Defaults to `'auto'`, preserving 100% of the automatic topology-adaptive pipeline.
 *    - Allows manual override to `'hierarchical'` (Dagre TB), `'organic'` (high-repulsion Cose),
 *      or `'circular'` (perimeter ring) via a split-button dropdown next to "Re-Layout / Center".
 * 2. Longest-Path Layered Topological Layout for Logical Graphs & DAGs:
 *    - Prevents sudden layout collapse when adding cross/convergent edges (such as `add_edge(g, 2, 1, 1)`
 *      at Step 36 in Dijkstra where `Node 1` reaches in-degree 2).
 * 3. Always-On 2D Radial Collision Guard for Logical Vertices (`resolveLiveCanvasOverlaps`).
 * 4. Dynamic C Struct Field Name Edge Labels (`resolveEdgeFieldLabel`) & Self-Loop Suppression.
 * 5. Dynamic Chord Label Offset (`computeEdgeLabelOffsets`), Frame Persistence & Quote-Aware Struct Rows.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import cytoscape from "cytoscape";
import type { Core, LayoutOptions, NodeSingular } from "cytoscape";
import type {
  GraphData,
  GraphNode,
  GraphEdge,
  ArraySnapshot,
} from "../../types/debugger";
import {
  Share2,
  RotateCcw,
  Info,
  X,
  AlertOctagon,
  Loader2,
  Network,
  Cpu,
  ChevronDown,
  Check,
} from "lucide-react";

export interface LogicalGraphPayload {
  nodes: ExtendedGraphNode[];
  edges: ExtendedGraphEdge[];
  is_forest?: boolean;
}

export interface ExtendedGraphNode extends GraphNode {
  self_ref_order?: string[];
  status?: "active" | "freed" | string;
  is_dangling?: boolean;
  is_transient_retained?: boolean;
}

export interface ExtendedGraphEdge extends GraphEdge {
  field_order_idx?: number;
  fieldName?: string;
  field?: string;
  member?: string;
  name?: string;
  base_label?: string;
  is_active_edge?: boolean;
  has_active_metric?: boolean;
  directed?: boolean;
}

export interface ExtendedGraphData extends GraphData {
  nodes: ExtendedGraphNode[];
  edges: ExtendedGraphEdge[];
  logical_graph?: LogicalGraphPayload | null;
}

export interface GraphVisualizerProps {
  graph: ExtendedGraphData;
  logicalGraph?: LogicalGraphPayload | null;
  locals?: Record<string, number | string>;
  arrays?: ArraySnapshot[];
  isConnecting?: boolean;
}

type ViewMode = "logical" | "physical";
export type LayoutMode = "auto" | "hierarchical" | "organic" | "circular";
export type GraphTopologyKind =
  | "linear-list"
  | "circular-list"
  | "tree"
  | "general-graph";
export type LayoutTopologyCategory = "HIERARCHICAL" | "GENERAL_GRAPH";

interface BadgeOverlayItem {
  nodeId: string;
  x: number;
  y: number;
  pointers: string[];
  isFreed: boolean;
  isDangling: boolean;
}

interface RetainedNodeEntry {
  node: ExtendedGraphNode;
  missingFrames: number;
  lastPosition?: { x: number; y: number };
}

interface RetainedEdgeEntry {
  edge: ExtendedGraphEdge;
  missingFrames: number;
}

interface DagreLayoutConfig {
  name: "dagre";
  rankDir: "LR" | "TB";
  align: "UL";
  nodeSep: number;
  rankSep: number;
  edgeSep: number;
  ranker?: "network-simplex" | "tight-tree" | "longest-path";
  animate: boolean;
  animationDuration: number;
  fit: boolean;
  padding: number;
}

interface CustomDagreLayoutOptions {
  eles: {
    nodes: () => {
      forEach: (
        cb: (n: {
          id: () => string;
          data: (k: string) => unknown;
          position: () => { x: number; y: number };
        }) => void
      ) => void;
      layoutPositions: (
        layout: unknown,
        options: unknown,
        fn: (ele: {
          id: () => string;
          position: () => { x: number; y: number };
        }) => { x: number; y: number }
      ) => void;
    };
    edges: () => {
      forEach: (
        cb: (e: {
          source: () => { id: () => string };
          target: () => { id: () => string };
          data: (k: string) => unknown;
        }) => void
      ) => void;
    };
  };
  rankDir?: "LR" | "TB";
  align?: "UL";
  nodeSep?: number;
  rankSep?: number;
  edgeSep?: number;
}

const HEAP_CARD_WIDTH = 210;
const HEAP_CARD_MIN_HEIGHT = 95;
const LOGICAL_VERTEX_SIZE = 70;
const MIN_X_NUDGE_PX = 230;
const TRANSIENT_NODE_GRACE_FRAMES = 2;

const LAYOUT_MODE_OPTIONS: Array<{
  mode: LayoutMode;
  label: string;
  shortTag: string;
}> = [
  { mode: "auto", label: "Auto (Default)", shortTag: "Auto" },
  { mode: "hierarchical", label: "Hierarchical (Tree)", shortTag: "Tree" },
  { mode: "organic", label: "Organic (Scattered)", shortTag: "Organic" },
  { mode: "circular", label: "Circular (Ring)", shortTag: "Ring" },
];

const BADGE_PALETTE = [
  "bg-emerald-400 text-slate-950 border-emerald-200 shadow-[0_0_10px_rgba(52,211,153,0.5)]",
  "bg-cyan-400 text-slate-950 border-cyan-200 shadow-[0_0_10px_rgba(34,211,238,0.5)]",
  "bg-violet-500 text-white border-violet-300 shadow-[0_0_10px_rgba(139,92,246,0.45)]",
  "bg-amber-400 text-slate-950 border-amber-200 shadow-[0_0_10px_rgba(251,191,36,0.5)]",
  "bg-fuchsia-500 text-white border-fuchsia-300",
  "bg-sky-400 text-slate-950 border-sky-200",
];

function getPointerBadgeStyle(ptrName: string): string {
  let hash = 0;
  for (let i = 0; i < ptrName.length; i++) {
    hash = (hash * 31 + ptrName.charCodeAt(i)) >>> 0;
  }
  return BADGE_PALETTE[hash % BADGE_PALETTE.length];
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeStructType(node: ExtendedGraphNode): string {
  return (node.c_type || node.type || "struct")
    .replace(/^const\s+/, "")
    .replace(/^struct\s+/, "")
    .trim();
}

function isNullAddressToken(val: string | undefined | null): boolean {
  if (val === undefined || val === null) return true;
  const trimmed = String(val).trim();
  if (
    trimmed === "" ||
    trimmed === "NULL" ||
    trimmed === "null" ||
    trimmed === "0x0" ||
    trimmed === "0X0" ||
    trimmed === "(nil)" ||
    trimmed === "0"
  ) {
    return true;
  }
  if (/^0x0+$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function isValidEdgeEndpoint(endpoint: string | undefined | null): boolean {
  if (!endpoint) return false;
  if (isNullAddressToken(endpoint)) return false;
  return true;
}

function isValidGraphEdge(
  edge: ExtendedGraphEdge,
  validNodeIds?: Set<string>,
  disallowSelfLoops: boolean = false
): boolean {
  if (!isValidEdgeEndpoint(edge.source) || !isValidEdgeEndpoint(edge.target)) {
    return false;
  }
  if (disallowSelfLoops && edge.source === edge.target) {
    return false;
  }
  if (validNodeIds) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves the dynamic C struct field/member name from an incoming edge object without
 * any hardcoded fallback strings.
 */
function resolveEdgeFieldLabel(edge: ExtendedGraphEdge): string {
  const raw =
    edge.fieldName ??
    edge.field ??
    edge.member ??
    edge.name ??
    edge.label ??
    "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return trimmed;
}

/**
 * Computes a deterministic tangential & normal offset (`textOffsetX`, `textOffsetY`)
 * for edge labels so crossing chords in dense graphs stagger their label pills
 * instead of overlapping at the center of the canvas.
 */
function computeEdgeLabelOffsets(
  sourceId: string,
  targetId: string,
  edgeIndex: number
): { textOffsetX: number; textOffsetY: number } {
  const combined = `${sourceId}->${targetId}#${edgeIndex}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 33 + combined.charCodeAt(i)) >>> 0;
  }
  const slot = hash % 5; // 0..4
  const offsetSteps = [-24, -12, 0, 12, 24];
  const normalSteps = [-14, -9, -11, -16, -8];
  return {
    textOffsetX: offsetSteps[slot],
    textOffsetY: normalSteps[(slot + edgeIndex) % normalSteps.length],
  };
}

export interface StructFieldRow {
  key: string;
  value: string;
}

/**
 * Splits a top-level comma-separated GDB struct body into individual "key = value"
 * tokens while respecting single-quoted char literals (e.g., `123 '{'`), double-quoted
 * strings, and balanced braces/brackets.
 */
export function splitBalancedStructTokens(rawInner: string): string[] {
  const tokens: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let startIdx = 0;

  for (let i = 0; i < rawInner.length; i++) {
    const ch = rawInner[i];

    if (ch === "\\" && (inSingleQuote || inDoubleQuote)) {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (
      ch === "," &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      const piece = rawInner.slice(startIdx, i).trim();
      if (piece) tokens.push(piece);
      startIdx = i + 1;
    }
  }

  const tail = rawInner.slice(startIdx).trim();
  if (tail) tokens.push(tail);
  return tokens;
}

/**
 * Quote-Aware Discrete Struct Field Extractor:
 * Parses node fields into explicit `{ key, value }` rows without breaking on character
 * or string literals containing commas or braces (`123 '{'`).
 */
export function extractDiscreteFieldRows(
  node: ExtendedGraphNode
): StructFieldRow[] {
  const rawFields = node.fields || {};
  const rows: StructFieldRow[] = [];
  const seenKeys = new Set<string>();

  const pushRow = (k: string, v: string) => {
    const cleanKey = k.trim();
    const cleanVal = v.trim();
    if (!cleanKey) return;
    if (seenKeys.has(cleanKey)) {
      const idx = rows.findIndex((r) => r.key === cleanKey);
      if (idx !== -1) rows[idx] = { key: cleanKey, value: cleanVal };
      return;
    }
    seenKeys.add(cleanKey);
    rows.push({ key: cleanKey, value: cleanVal });
  };

  Object.entries(rawFields).forEach(([rawKey, rawVal]) => {
    const valStr = Array.isArray(rawVal)
      ? `[${rawVal.join(", ")}]`
      : String(rawVal ?? "").trim();

    const segments = splitBalancedStructTokens(valStr);
    if (segments.length <= 1) {
      pushRow(rawKey, valStr);
      return;
    }

    const firstValParts: string[] = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|:)\s*(.+)$/.exec(seg);
      if (kvMatch) {
        pushRow(rawKey, firstValParts.join(", "));
        pushRow(kvMatch[1], kvMatch[2]);
      } else {
        firstValParts.push(seg);
      }
    }
    if (!seenKeys.has(rawKey.trim())) {
      pushRow(rawKey, firstValParts.join(", "));
    }
  });

  return rows;
}

function getEstimatedNodeDimensions(node: ExtendedGraphNode): {
  width: number;
  height: number;
} {
  if (node.type === "LogicalVertex") {
    return { width: LOGICAL_VERTEX_SIZE, height: LOGICAL_VERTEX_SIZE };
  }
  const fCount = extractDiscreteFieldRows(node).length;
  return {
    width: HEAP_CARD_WIDTH,
    height: Math.max(HEAP_CARD_MIN_HEIGHT, 44 + fCount * 20),
  };
}

/**
 * Resolves bounding-box overlaps without flattening 2D topologies into a horizontal line.
 */
function deoverlapNodePositions(
  positions: Record<string, { x: number; y: number }>,
  nodes: ExtendedGraphNode[],
  minGap: number = 36
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const dimById = new Map<string, { width: number; height: number }>();
  const isLogicalTopology =
    nodes.length > 0 && nodes.every((n) => n.type === "LogicalVertex");

  nodes.forEach((n, idx) => {
    dimById.set(n.id, getEstimatedNodeDimensions(n));
    const rawPos = positions[n.id];
    if (
      rawPos &&
      Number.isFinite(rawPos.x) &&
      Number.isFinite(rawPos.y)
    ) {
      result[n.id] = { x: Math.round(rawPos.x), y: Math.round(rawPos.y) };
    } else {
      result[n.id] = {
        x: 160 + (idx % 4) * 300,
        y: 160 + Math.floor(idx / 4) * 185,
      };
    }
  });

  const ids = Object.keys(result);
  if (ids.length <= 1) return result;

  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    ids.sort((a, b) => {
      const dx = result[a].x - result[b].x;
      if (Math.abs(dx) > 4) return dx;
      return result[a].y - result[b].y;
    });

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const idA = ids[i];
        const idB = ids[j];
        const pA = result[idA];
        const pB = result[idB];
        const dimA = dimById.get(idA) || {
          width: HEAP_CARD_WIDTH,
          height: HEAP_CARD_MIN_HEIGHT,
        };
        const dimB = dimById.get(idB) || {
          width: HEAP_CARD_WIDTH,
          height: HEAP_CARD_MIN_HEIGHT,
        };

        const reqDx = (dimA.width + dimB.width) / 2 + minGap;
        const reqDy = (dimA.height + dimB.height) / 2 + minGap;

        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (absDx < reqDx && absDy < reqDy) {
          moved = true;
          if (isLogicalTopology) {
            const dist = Math.hypot(dx, dy);
            const minRadial = Math.max(reqDx, reqDy, 155);
            const angle =
              dist < 4
                ? (2 * Math.PI * j) / Math.max(1, ids.length)
                : Math.atan2(dy, dx);
            const push = Math.max(26, (minRadial - dist) / 2 + 12);
            pA.x = Math.round(pA.x - push * Math.cos(angle));
            pA.y = Math.round(pA.y - push * Math.sin(angle));
            pB.x = Math.round(pB.x + push * Math.cos(angle));
            pB.y = Math.round(pB.y + push * Math.sin(angle));
          } else {
            const targetRightX =
              pA.x + Math.max(MIN_X_NUDGE_PX, Math.ceil(reqDx));
            if (pB.x < targetRightX) {
              pB.x = Math.round(targetRightX);
            } else {
              pB.x += MIN_X_NUDGE_PX;
            }
          }
        }
      }
    }
    if (!moved) break;
  }

  return result;
}

/**
 * Live Canvas Overlap Guard:
 * - Only skips on circular rings (`skipCircularRing = true`).
 * - For `LogicalVertex` nodes, enforces a 2D radial separation of at least
 *   `155px` center-to-center so `cose` or incremental updates can never crush nodes together.
 */
function resolveLiveCanvasOverlaps(
  cy: Core,
  skipCircularRing: boolean = false
): void {
  if (skipCircularRing) return;
  const cyNodes = cy.nodes().filter((n) => !n.data("isDeleting"));
  if (cyNodes.length <= 1) return;

  const items: Array<{
    node: NodeSingular;
    x: number;
    y: number;
    w: number;
    h: number;
    isLogical: boolean;
  }> = [];

  cyNodes.forEach((n) => {
    const pos = n.position();
    const isLogical = Boolean(n.data("isLogicalVertex"));
    const w =
      Number(n.data("width")) ||
      (isLogical ? LOGICAL_VERTEX_SIZE : HEAP_CARD_WIDTH);
    const h =
      Number(n.data("height")) ||
      (isLogical ? LOGICAL_VERTEX_SIZE : HEAP_CARD_MIN_HEIGHT);
    items.push({ node: n, x: pos.x, y: pos.y, w, h, isLogical });
  });

  let anyModified = false;
  for (let pass = 0; pass < 10; pass++) {
    let movedInPass = false;
    items.sort((a, b) => (Math.abs(a.x - b.x) > 4 ? a.x - b.x : a.y - b.y));

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const minGap = a.isLogical && b.isLogical ? 75 : 24;
        const reqDx = (a.w + b.w) / 2 + minGap;
        const reqDy = (a.h + b.h) / 2 + (a.isLogical && b.isLogical ? 75 : 20);

        const dx = b.x - a.x;
        const dy = b.y - a.y;

        if (Math.abs(dx) < reqDx && Math.abs(dy) < reqDy) {
          if (a.isLogical && b.isLogical) {
            const dist = Math.hypot(dx, dy);
            const minRadial = 155;
            if (dist < minRadial) {
              const angle =
                dist < 4
                  ? (2 * Math.PI * j) / Math.max(1, items.length)
                  : Math.atan2(dy, dx);
              const push = Math.max(18, (minRadial - dist) / 2 + 8);
              a.x -= push * Math.cos(angle);
              a.y -= push * Math.sin(angle);
              b.x += push * Math.cos(angle);
              b.y += push * Math.sin(angle);
              movedInPass = true;
              anyModified = true;
            }
          } else {
            const minTargetX =
              a.x + Math.max(MIN_X_NUDGE_PX, Math.ceil(reqDx));
            b.x = Math.max(b.x + MIN_X_NUDGE_PX, minTargetX);
            movedInPass = true;
            anyModified = true;
          }
        }
      }
    }
    if (!movedInPass) break;
  }

  if (anyModified) {
    cy.batch(() => {
      items.forEach((it) => {
        it.node.position({ x: Math.round(it.x), y: Math.round(it.y) });
      });
    });
  }
}

function partitionContainersAndBackbone(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): {
  containerNodes: ExtendedGraphNode[];
  backboneNodes: ExtendedGraphNode[];
  backboneEdges: ExtendedGraphEdge[];
} {
  if (nodes.length <= 1) {
    return {
      containerNodes: [],
      backboneNodes: nodes,
      backboneEdges: edges.filter((e) => isValidGraphEdge(e, undefined, true)),
    };
  }

  const nodeById = new Map<string, ExtendedGraphNode>();
  nodes.forEach((n) => {
    if (isValidEdgeEndpoint(n.id)) {
      nodeById.set(n.id, n);
    }
  });

  const validEdges: ExtendedGraphEdge[] = edges.filter(
    (e) =>
      isValidEdgeEndpoint(e.source) &&
      isValidEdgeEndpoint(e.target) &&
      nodeById.has(e.source) &&
      nodeById.has(e.target) &&
      e.source !== e.target
  );

  const inDeg = new Map<string, number>();
  const outEdgesByNode = new Map<string, ExtendedGraphEdge[]>();
  nodes.forEach((n) => {
    inDeg.set(n.id, 0);
    outEdgesByNode.set(n.id, []);
  });

  validEdges.forEach((e) => {
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    outEdgesByNode.get(e.source)?.push(e);
  });

  const containerIds = new Set<string>();

  nodes.forEach((n) => {
    if (n.type === "LogicalVertex" || n.type === "IndexNode") return;
    const nodeIn = inDeg.get(n.id) || 0;
    const outs = outEdgesByNode.get(n.id) || [];
    const selfRefCount = n.self_ref_order?.length ?? 0;

    if (nodeIn === 0 && outs.length >= 1 && selfRefCount === 0) {
      const nType = normalizeStructType(n);
      const targetsDifferentOrSelfRefType = outs.every((e) => {
        const tgt = nodeById.get(e.target);
        if (!tgt) return false;
        const tgtType = normalizeStructType(tgt);
        const tgtSelfRef = tgt.self_ref_order?.length ?? 0;
        return tgtType !== nType || tgtSelfRef > 0;
      });

      if (targetsDifferentOrSelfRefType) {
        containerIds.add(n.id);
      }
    }
  });

  if (containerIds.size === 0 || containerIds.size >= nodes.length) {
    return {
      containerNodes: [],
      backboneNodes: nodes,
      backboneEdges: validEdges,
    };
  }

  const containerNodes: ExtendedGraphNode[] = nodes.filter((n) =>
    containerIds.has(n.id)
  );
  const backboneNodes: ExtendedGraphNode[] = nodes.filter(
    (n) => !containerIds.has(n.id)
  );
  const backboneEdges: ExtendedGraphEdge[] = validEdges.filter(
    (e) => !containerIds.has(e.source) && !containerIds.has(e.target)
  );

  return {
    containerNodes,
    backboneNodes,
    backboneEdges,
  };
}

export function detectTopology(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): GraphTopologyKind {
  if (nodes.length <= 1) {
    return "linear-list";
  }

  const { backboneNodes, backboneEdges } = partitionContainersAndBackbone(
    nodes,
    edges
  );

  const evalNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
  const nodeIds = new Set<string>(evalNodes.map((n) => n.id));
  const validEdges: ExtendedGraphEdge[] = (
    backboneNodes.length > 0 ? backboneEdges : edges
  ).filter((e) => isValidGraphEdge(e, nodeIds, true));

  if (validEdges.length === 0) {
    return "linear-list";
  }

  const undirNeighbors = new Map<string, Set<string>>();
  evalNodes.forEach((n) => undirNeighbors.set(n.id, new Set<string>()));

  validEdges.forEach((e) => {
    undirNeighbors.get(e.source)?.add(e.target);
    undirNeighbors.get(e.target)?.add(e.source);
  });

  const visited = new Set<string>();
  let hasUndirectedCycle = false;
  let allCyclicComponentsAre2Regular = true;
  let cyclicComponentCount = 0;
  let maxUndirectedDegree = 0;

  for (const n of evalNodes) {
    const deg = undirNeighbors.get(n.id)?.size ?? 0;
    if (deg > maxUndirectedDegree) {
      maxUndirectedDegree = deg;
    }

    if (!visited.has(n.id)) {
      const compNodes: string[] = [];
      const queue: string[] = [n.id];
      visited.add(n.id);

      while (queue.length > 0) {
        const curr: string = queue.shift()!;
        compNodes.push(curr);
        const nbrs = undirNeighbors.get(curr);
        if (nbrs) {
          nbrs.forEach((nbr) => {
            if (!visited.has(nbr)) {
              visited.add(nbr);
              queue.push(nbr);
            }
          });
        }
      }

      let compUndirEdgeCount = 0;
      let isComp2Regular = compNodes.length >= 3;
      compNodes.forEach((u) => {
        const uDeg = undirNeighbors.get(u)?.size ?? 0;
        if (uDeg !== 2) {
          isComp2Regular = false;
        }
        const nbrs = undirNeighbors.get(u);
        if (nbrs) {
          nbrs.forEach((v) => {
            if (u < v) compUndirEdgeCount += 1;
          });
        }
      });

      if (compUndirEdgeCount >= compNodes.length) {
        hasUndirectedCycle = true;
        cyclicComponentCount += 1;
        if (compUndirEdgeCount !== compNodes.length || !isComp2Regular) {
          allCyclicComponentsAre2Regular = false;
        }
      }
    }
  }

  if (hasUndirectedCycle) {
    if (
      cyclicComponentCount >= 1 &&
      allCyclicComponentsAre2Regular &&
      maxUndirectedDegree <= 2
    ) {
      return "circular-list";
    }
    return "general-graph";
  }

  const directedPairSet = new Set<string>(
    validEdges.map((e) => `${e.source}->${e.target}`)
  );

  if (
    evalNodes.length === 2 &&
    validEdges.length >= 2 &&
    directedPairSet.has(`${evalNodes[0].id}->${evalNodes[1].id}`) &&
    directedPairSet.has(`${evalNodes[1].id}->${evalNodes[0].id}`)
  ) {
    if (validEdges.length >= 4) {
      return "circular-list";
    }
    const bothHaveZeroNullSelfRefs = evalNodes.every((n) => {
      const selfRefs = n.self_ref_order || [];
      if (selfRefs.length === 0) return false;
      return selfRefs.every((fName) => {
        const fVal = n.fields?.[fName];
        return fVal !== undefined && !isNullAddressToken(String(fVal));
      });
    });
    if (bothHaveZeroNullSelfRefs) {
      return "circular-list";
    }
  }

  const nonSymInDeg: Record<string, number> = {};
  const nonSymOutDeg: Record<string, number> = {};
  evalNodes.forEach((n) => {
    nonSymInDeg[n.id] = 0;
    nonSymOutDeg[n.id] = 0;
  });

  validEdges.forEach((e) => {
    if (!directedPairSet.has(`${e.target}->${e.source}`)) {
      nonSymOutDeg[e.source] = (nonSymOutDeg[e.source] || 0) + 1;
      nonSymInDeg[e.target] = (nonSymInDeg[e.target] || 0) + 1;
    }
  });

  const maxNonSymIn = Math.max(0, ...Object.values(nonSymInDeg));
  const maxNonSymOut = Math.max(0, ...Object.values(nonSymOutDeg));
  if (maxNonSymIn > 1 && maxNonSymOut > 1) {
    return "general-graph";
  }

  if (maxUndirectedDegree <= 2) {
    let hasPureBranchingRoot = false;
    evalNodes.forEach((n) => {
      if ((nonSymOutDeg[n.id] || 0) >= 2 || (nonSymInDeg[n.id] || 0) >= 2) {
        hasPureBranchingRoot = true;
      }
    });

    if (!hasPureBranchingRoot) {
      return "linear-list";
    }
  }

  return "tree";
}

export function classifyLayoutTopology(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[],
  isForestTopology: boolean = false
): LayoutTopologyCategory {
  if (nodes.length <= 1) {
    return "HIERARCHICAL";
  }

  if (isForestTopology) {
    return "HIERARCHICAL";
  }

  const isLogicalVertexGraph = nodes.every((n) => n.type === "LogicalVertex");
  if (isLogicalVertexGraph) {
    return "HIERARCHICAL";
  }

  const { backboneNodes, backboneEdges } = partitionContainersAndBackbone(
    nodes,
    edges
  );

  const evalNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
  const nodeIds = new Set<string>(evalNodes.map((n) => n.id));
  const validEdges = (backboneNodes.length > 0 ? backboneEdges : edges).filter(
    (e) => isValidGraphEdge(e, nodeIds, true)
  );

  if (validEdges.length === 0) {
    return "HIERARCHICAL";
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const undirAdj = new Map<string, Set<string>>();

  evalNodes.forEach((n) => {
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
    undirAdj.set(n.id, new Set<string>());
  });

  validEdges.forEach((e) => {
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    outDegree.set(e.source, (outDegree.get(e.source) || 0) + 1);
    undirAdj.get(e.source)?.add(e.target);
    undirAdj.get(e.target)?.add(e.source);
  });

  const visited = new Set<string>();
  for (const n of evalNodes) {
    if (visited.has(n.id)) continue;

    const compNodes: string[] = [];
    const queue: string[] = [n.id];
    visited.add(n.id);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      compNodes.push(curr);
      undirAdj.get(curr)?.forEach((nbr) => {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      });
    }

    let compUndirEdges = 0;
    compNodes.forEach((u) => {
      undirAdj.get(u)?.forEach((v) => {
        if (u < v) compUndirEdges += 1;
      });
    });

    if (compUndirEdges >= compNodes.length) {
      return "GENERAL_GRAPH";
    }
  }

  const directedPairs = new Set<string>(
    validEdges.map((e) => `${e.source}->${e.target}`)
  );
  for (const e of validEdges) {
    if (directedPairs.has(`${e.target}->${e.source}`)) {
      return "GENERAL_GRAPH";
    }
  }

  const maxIn = Math.max(0, ...Array.from(inDegree.values()));
  const maxOut = Math.max(0, ...Array.from(outDegree.values()));
  const isParentPointerForest = maxOut <= 1;

  if (maxIn >= 2 && !isParentPointerForest) {
    return "GENERAL_GRAPH";
  }

  return "HIERARCHICAL";
}

function computeOrderedCycleIds(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): string[] {
  if (nodes.length === 0) return [];

  const { containerNodes, backboneNodes, backboneEdges } =
    partitionContainersAndBackbone(nodes, edges);

  const ringNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
  const ringIds = new Set<string>(ringNodes.map((n) => n.id));
  const validEdges: ExtendedGraphEdge[] = (
    backboneNodes.length > 0 ? backboneEdges : edges
  ).filter((e) => isValidGraphEdge(e, ringIds, true));

  const outEdgesByNode = new Map<string, ExtendedGraphEdge[]>();
  const undirAdj = new Map<string, string[]>();

  ringNodes.forEach((n) => {
    outEdgesByNode.set(n.id, []);
    undirAdj.set(n.id, []);
  });

  validEdges.forEach((e) => {
    outEdgesByNode.get(e.source)!.push(e);

    const uList = undirAdj.get(e.source)!;
    if (!uList.includes(e.target)) uList.push(e.target);
    const vList = undirAdj.get(e.target)!;
    if (!vList.includes(e.source)) vList.push(e.source);
  });

  outEdgesByNode.forEach((edgeList) => {
    edgeList.sort(
      (a, b) => (a.field_order_idx ?? 0) - (b.field_order_idx ?? 0)
    );
  });

  const anchorCandidates = [...ringNodes].sort((a, b) => {
    const aHasPtr = (a.pointers?.length ?? 0) > 0 ? 0 : 1;
    const bHasPtr = (b.pointers?.length ?? 0) > 0 ? 0 : 1;
    return aHasPtr - bHasPtr;
  });

  const visited = new Set<string>();
  const orderedCycleIds: string[] = [];

  for (const startNode of anchorCandidates) {
    if (visited.has(startNode.id)) continue;

    const startOuts = outEdgesByNode.get(startNode.id) || [];
    const primaryLabel: string | undefined =
      startOuts.length > 0 ? startOuts[0].label : undefined;

    let curr: string | undefined = startNode.id;
    let prev: string | undefined = undefined;

    while (curr && !visited.has(curr)) {
      visited.add(curr);
      orderedCycleIds.push(curr);

      const currId: string = curr;
      const prevId: string | undefined = prev;
      const outs: ExtendedGraphEdge[] = outEdgesByNode.get(currId) || [];

      let chosenNext: string | undefined;
      if (primaryLabel !== undefined) {
        const matchPrimary: ExtendedGraphEdge | undefined = outs.find(
          (e) =>
            e.label === primaryLabel &&
            !visited.has(e.target) &&
            e.target !== prevId
        );
        if (matchPrimary) {
          chosenNext = matchPrimary.target;
        }
      }

      if (!chosenNext) {
        const anyOut: ExtendedGraphEdge | undefined = outs.find(
          (e) => !visited.has(e.target) && e.target !== prevId
        );
        if (anyOut) {
          chosenNext = anyOut.target;
        }
      }

      if (!chosenNext) {
        const nbrs: string[] = undirAdj.get(currId) || [];
        const fallbackUndir: string | undefined = nbrs.find(
          (nbr) => !visited.has(nbr) && nbr !== prevId
        );
        chosenNext = fallbackUndir;
      }

      prev = currId;
      curr = chosenNext;
    }
  }

  containerNodes.forEach((cNode) => {
    if (!visited.has(cNode.id)) {
      visited.add(cNode.id);
      orderedCycleIds.push(cNode.id);
    }
  });

  return orderedCycleIds;
}

function computeCircularListPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const { containerNodes, backboneNodes } = partitionContainersAndBackbone(
    nodes,
    edges
  );

  const ringNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
  const orderedCycleIds = computeOrderedCycleIds(nodes, edges);

  const orderedRing = [...ringNodes].sort((a, b) => {
    const idxA = orderedCycleIds.indexOf(a.id);
    const idxB = orderedCycleIds.indexOf(b.id);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    return 0;
  });

  const N = orderedRing.length;
  const centerX = 420;
  const centerY = 300;

  const minChord = 360;
  const computedRadius =
    N <= 1
      ? 0
      : N === 2
      ? 230
      : Math.max(
          230,
          Math.round(minChord / (2 * Math.sin(Math.PI / N)))
        );

  orderedRing.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, N) - Math.PI / 2;
    const x = Math.round(centerX + computedRadius * Math.cos(angle));
    const y = Math.round(centerY + computedRadius * Math.sin(angle));
    positions[node.id] = { x, y };
  });

  if (containerNodes.length > 0) {
    containerNodes.forEach((cNode, cIdx) => {
      positions[cNode.id] = {
        x: Math.round(
          centerX + (cIdx - (containerNodes.length - 1) / 2) * 300
        ),
        y: Math.round(centerY - computedRadius - 170),
      };
    });
  }

  return positions;
}

const INDEXED_EDGE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/;

function computeLayeredLogicalGraphPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[],
  nodeSep: number = 115,
  rankSep: number = 115
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const validIds = new Set<string>(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) =>
    isValidGraphEdge(e, validIds, true)
  );

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  const inAdj = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDeg.set(n.id, 0);
    outDeg.set(n.id, 0);
    outAdj.set(n.id, []);
    inAdj.set(n.id, []);
  });

  validEdges.forEach((e) => {
    outDeg.set(e.source, (outDeg.get(e.source) || 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    if (!outAdj.get(e.source)!.includes(e.target)) {
      outAdj.get(e.source)!.push(e.target);
    }
    if (!inAdj.get(e.target)!.includes(e.source)) {
      inAdj.get(e.target)!.push(e.source);
    }
  });

  const connectedNodes = nodes.filter(
    (n) => (inDeg.get(n.id) || 0) + (outDeg.get(n.id) || 0) > 0
  );
  const isolatedNodes =
    connectedNodes.length > 0
      ? nodes.filter(
          (n) => (inDeg.get(n.id) || 0) + (outDeg.get(n.id) || 0) === 0
        )
      : nodes;

  const maxIn = Math.max(0, ...Array.from(inDeg.values()));
  const maxOut = Math.max(0, ...Array.from(outDeg.values()));
  const isParentPointerDSU = maxOut <= 1 && maxIn > 1;

  const rankById = new Map<string, number>();

  if (connectedNodes.length > 0) {
    if (isParentPointerDSU) {
      const roots = connectedNodes.filter((n) => (outDeg.get(n.id) || 0) === 0);
      const seeds = roots.length > 0 ? roots : [connectedNodes[0]];
      const visited = new Set<string>();
      const queue: Array<{ id: string; r: number }> = [];

      seeds.forEach((s) => {
        visited.add(s.id);
        rankById.set(s.id, 0);
        queue.push({ id: s.id, r: 0 });
      });

      while (queue.length > 0) {
        const { id, r } = queue.shift()!;
        const children = inAdj.get(id) || [];
        children.forEach((chId) => {
          if (!visited.has(chId)) {
            visited.add(chId);
            rankById.set(chId, r + 1);
            queue.push({ id: chId, r: r + 1 });
          }
        });
      }

      connectedNodes.forEach((n) => {
        if (!rankById.has(n.id)) rankById.set(n.id, 0);
      });
    } else {
      const sources = connectedNodes.filter((n) => (inDeg.get(n.id) || 0) === 0);
      const seeds = sources.length > 0 ? sources : [connectedNodes[0]];

      connectedNodes.forEach((n) => rankById.set(n.id, 0));
      seeds.forEach((s) => rankById.set(s.id, 0));

      const maxRankCap = Math.min(8, connectedNodes.length);
      const nodeOrderIndex = new Map<string, number>();
      connectedNodes.forEach((n, idx) => nodeOrderIndex.set(n.id, idx));

      for (let pass = 0; pass < connectedNodes.length; pass++) {
        let changed = false;
        validEdges.forEach((e) => {
          const rU = rankById.get(e.source) ?? 0;
          const rV = rankById.get(e.target) ?? 0;
          const idxU = nodeOrderIndex.get(e.source) ?? 0;
          const idxV = nodeOrderIndex.get(e.target) ?? 0;
          const isBackEdge =
            idxU > idxV &&
            (outAdj.get(e.target)?.includes(e.source) || rU >= rV + 1);

          if (!isBackEdge && rV < rU + 1 && rU + 1 < maxRankCap) {
            rankById.set(e.target, rU + 1);
            changed = true;
          }
        });
        if (!changed) break;
      }
    }
  }

  const layers = new Map<number, ExtendedGraphNode[]>();
  let maxLayerRank = 0;
  connectedNodes.forEach((n) => {
    const r = rankById.get(n.id) ?? 0;
    if (r > maxLayerRank) maxLayerRank = r;
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r)!.push(n);
  });

  const horizStep = LOGICAL_VERTEX_SIZE + Math.max(115, nodeSep);
  const vertStep = LOGICAL_VERTEX_SIZE + Math.max(105, rankSep);
  const treeCenterX = 330;
  const startTopY = 120;

  let maxConnectedRightX = treeCenterX;

  for (let r = 0; r <= maxLayerRank; r++) {
    const layerNodes = layers.get(r) || [];
    if (layerNodes.length === 0) continue;

    if (r > 0) {
      layerNodes.sort((a, b) => {
        const parentsA = (isParentPointerDSU ? outAdj.get(a.id) : inAdj.get(a.id)) || [];
        const parentsB = (isParentPointerDSU ? outAdj.get(b.id) : inAdj.get(b.id)) || [];
        const avgXA =
          parentsA.length > 0
            ? parentsA.reduce((acc, pId) => acc + (positions[pId]?.x ?? treeCenterX), 0) /
              parentsA.length
            : treeCenterX;
        const avgXB =
          parentsB.length > 0
            ? parentsB.reduce((acc, pId) => acc + (positions[pId]?.x ?? treeCenterX), 0) /
              parentsB.length
            : treeCenterX;
        if (Math.abs(avgXA - avgXB) > 4) return avgXA - avgXB;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      });
    }

    const layerWidth = (layerNodes.length - 1) * horizStep;
    const leftX = treeCenterX - layerWidth / 2;
    const y = startTopY + r * vertStep;

    layerNodes.forEach((n, idx) => {
      const staggerY =
        layerNodes.length >= 3 && idx % 2 === 1 ? 24 : 0;
      const x = Math.round(leftX + idx * horizStep);
      positions[n.id] = { x, y: Math.round(y + staggerY) };
      if (x > maxConnectedRightX) maxConnectedRightX = x;
    });
  }

  if (isolatedNodes.length > 0) {
    const colsPerRow = connectedNodes.length > 0 ? 2 : 4;
    const startSingletonX =
      connectedNodes.length > 0
        ? Math.max(560, maxConnectedRightX + 185)
        : 180;
    const pitchX = LOGICAL_VERTEX_SIZE + 75;
    const pitchY = LOGICAL_VERTEX_SIZE + 70;

    isolatedNodes.forEach((sNode, idx) => {
      const col = idx % colsPerRow;
      const row = Math.floor(idx / colsPerRow);
      positions[sNode.id] = {
        x: Math.round(startSingletonX + col * pitchX),
        y: Math.round(startTopY + row * pitchY),
      };
    });
  }

  return deoverlapNodePositions(positions, nodes, 48);
}

function computeDagreHierarchicalPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[],
  config: {
    rankDir: "LR" | "TB";
    align?: "UL";
    nodeSep: number;
    rankSep: number;
    edgeSep: number;
  }
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  if (
    config.rankDir === "TB" &&
    nodes.every((n) => n.type === "LogicalVertex")
  ) {
    return computeLayeredLogicalGraphPositions(
      nodes,
      edges,
      config.nodeSep,
      config.rankSep
    );
  }

  const effectiveNodeSep = Math.max(90, config.nodeSep);
  const effectiveRankSep = Math.max(110, config.rankSep);

  const nodeMap = new Map<string, ExtendedGraphNode>();
  const nodeDims = new Map<string, { width: number; height: number }>();

  nodes.forEach((n) => {
    if (!isValidEdgeEndpoint(n.id)) return;
    nodeMap.set(n.id, n);
    nodeDims.set(n.id, getEstimatedNodeDimensions(n));
  });

  const allValidEdges: ExtendedGraphEdge[] = edges.filter(
    (e) =>
      isValidEdgeEndpoint(e.source) &&
      isValidEdgeEndpoint(e.target) &&
      nodeMap.has(e.source) &&
      nodeMap.has(e.target) &&
      e.source !== e.target
  );

  if (config.rankDir === "LR") {
    const { containerNodes, backboneNodes, backboneEdges } =
      partitionContainersAndBackbone(nodes, allValidEdges);

    const chainNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
    const chainEdges =
      backboneNodes.length > 0 ? backboneEdges : allValidEdges;

    const undirAdj = new Map<string, string[]>();
    const forwardInDeg = new Map<string, number>();
    const directedSet = new Set<string>(
      chainEdges.map((e) => `${e.source}->${e.target}`)
    );

    chainNodes.forEach((n) => {
      undirAdj.set(n.id, []);
      forwardInDeg.set(n.id, 0);
    });

    chainEdges.forEach((e) => {
      const uList = undirAdj.get(e.source)!;
      if (!uList.includes(e.target)) uList.push(e.target);
      const vList = undirAdj.get(e.target)!;
      if (!vList.includes(e.source)) vList.push(e.source);

      if (!directedSet.has(`${e.target}->${e.source}`)) {
        forwardInDeg.set(e.target, (forwardInDeg.get(e.target) || 0) + 1);
      }
    });

    const bucketOrderByNodeId = new Map<string, number>();
    containerNodes.forEach((cNode) => {
      allValidEdges
        .filter((e) => e.source === cNode.id)
        .forEach((e, idx) => {
          const m = INDEXED_EDGE_RE.exec(e.label || "");
          const orderVal = m ? Number(m[2]) : e.field_order_idx ?? idx;
          if (!bucketOrderByNodeId.has(e.target)) {
            bucketOrderByNodeId.set(e.target, orderVal);
          }
        });
    });

    const visited = new Set<string>();
    const chains: string[][] = [];

    const sortedCandidates = [...chainNodes].sort((a, b) => {
      const aBucket = bucketOrderByNodeId.get(a.id) ?? 9999;
      const bBucket = bucketOrderByNodeId.get(b.id) ?? 9999;
      if (aBucket !== bBucket) return aBucket - bBucket;

      const aIn = forwardInDeg.get(a.id) ?? 0;
      const bIn = forwardInDeg.get(b.id) ?? 0;
      if (aIn !== bIn) return aIn - bIn;

      const aDeg = undirAdj.get(a.id)?.length ?? 0;
      const bDeg = undirAdj.get(b.id)?.length ?? 0;
      const aIsEnd = aDeg <= 1 ? 0 : 1;
      const bIsEnd = bDeg <= 1 ? 0 : 1;
      if (aIsEnd !== bIsEnd) return aIsEnd - bIsEnd;

      const aHasPtr = (a.pointers?.length ?? 0) > 0 ? 0 : 1;
      const bHasPtr = (b.pointers?.length ?? 0) > 0 ? 0 : 1;
      return aHasPtr - bHasPtr;
    });

    for (const startNode of sortedCandidates) {
      if (visited.has(startNode.id)) continue;

      const chain: string[] = [];
      let curr: string | undefined = startNode.id;

      while (curr && !visited.has(curr)) {
        visited.add(curr);
        chain.push(curr);
        const currentId: string = curr;
        const nextOutgoing: ExtendedGraphEdge | undefined = chainEdges.find(
          (e) => e.source === currentId && !visited.has(e.target)
        );
        if (nextOutgoing) {
          curr = nextOutgoing.target;
        } else {
          const neighbors: string[] = undirAdj.get(currentId) || [];
          const fallbackNbr: string | undefined = neighbors.find(
            (nbr) => !visited.has(nbr)
          );
          curr = fallbackNbr;
        }
      }
      chains.push(chain);
    }

    const isMultiLaneContainer =
      containerNodes.length > 0 && chains.length >= 2;
    const chainStartX = isMultiLaneContainer
      ? 160 + HEAP_CARD_WIDTH + effectiveRankSep + 30
      : 160;
    let currentRowY =
      containerNodes.length > 0 && !isMultiLaneContainer ? 280 : 150;

    chains.forEach((chain) => {
      let cursorX = chainStartX;
      let maxChainHeight = HEAP_CARD_MIN_HEIGHT;

      chain.forEach((nodeId, idx) => {
        const dim = nodeDims.get(nodeId) || {
          width: HEAP_CARD_WIDTH,
          height: HEAP_CARD_MIN_HEIGHT,
        };
        maxChainHeight = Math.max(maxChainHeight, dim.height);
        if (idx === 0) {
          positions[nodeId] = { x: cursorX, y: currentRowY + dim.height / 2 };
        } else {
          const prevId = chain[idx - 1];
          const prevDim = nodeDims.get(prevId) || {
            width: HEAP_CARD_WIDTH,
            height: HEAP_CARD_MIN_HEIGHT,
          };
          const stepX = prevDim.width / 2 + effectiveRankSep + dim.width / 2;
          cursorX += stepX;
          positions[nodeId] = {
            x: Math.round(cursorX),
            y: currentRowY + dim.height / 2,
          };
        }
      });

      currentRowY += maxChainHeight + effectiveNodeSep;
    });

    if (containerNodes.length > 0) {
      containerNodes.forEach((cNode, cIdx) => {
        const cTargets = allValidEdges
          .filter(
            (e) => e.source === cNode.id && positions[e.target] !== undefined
          )
          .map((e) => positions[e.target]);

        const cDim = nodeDims.get(cNode.id) || {
          width: HEAP_CARD_WIDTH,
          height: HEAP_CARD_MIN_HEIGHT,
        };

        if (isMultiLaneContainer && cTargets.length > 0) {
          const minY = Math.min(...cTargets.map((pos) => pos.y));
          const maxY = Math.max(...cTargets.map((pos) => pos.y));
          positions[cNode.id] = {
            x: 160,
            y: Math.round(
              (minY + maxY) / 2 + cIdx * (cDim.height + effectiveNodeSep)
            ),
          };
        } else if (cTargets.length > 0) {
          const avgX =
            cTargets.reduce((sum, pos) => sum + pos.x, 0) / cTargets.length;
          const minY = Math.min(...cTargets.map((pos) => pos.y));
          positions[cNode.id] = {
            x: Math.round(avgX + cIdx * 280),
            y: Math.round(minY - cDim.height / 2 - effectiveRankSep),
          };
        } else {
          positions[cNode.id] = {
            x: 160 + cIdx * 280,
            y: 100,
          };
        }
      });
    }

    return deoverlapNodePositions(positions, nodes, 36);
  }

  const { containerNodes, backboneNodes, backboneEdges } =
    partitionContainersAndBackbone(nodes, allValidEdges);

  const treeNodes = backboneNodes.length > 0 ? backboneNodes : nodes;
  const validEdges =
    backboneNodes.length > 0 ? backboneEdges : allValidEdges;

  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const directedSet = new Set<string>(
    validEdges.map((e) => `${e.source}->${e.target}`)
  );

  treeNodes.forEach((n) => {
    inDegree[n.id] = 0;
    outDegree[n.id] = 0;
  });

  validEdges.forEach((e) => {
    outDegree[e.source] = (outDegree[e.source] || 0) + 1;
    inDegree[e.target] = (inDegree[e.target] || 0) + 1;
  });

  const maxIn = Math.max(0, ...Object.values(inDegree));
  const maxOut = Math.max(0, ...Object.values(outDegree));
  const isParentPointerForest = maxOut <= 1 && maxIn > 1;

  const treeChildren = new Map<
    string,
    Array<{ childId: string; slotIdx: number }>
  >();
  treeNodes.forEach((n) => treeChildren.set(n.id, []));

  if (isParentPointerForest) {
    validEdges.forEach((e, idx) => {
      treeChildren.get(e.target)?.push({ childId: e.source, slotIdx: idx });
    });
  } else {
    const nonSymInDeg: Record<string, number> = {};
    treeNodes.forEach((n) => (nonSymInDeg[n.id] = 0));
    validEdges.forEach((e) => {
      if (!directedSet.has(`${e.target}->${e.source}`)) {
        nonSymInDeg[e.target] = (nonSymInDeg[e.target] || 0) + 1;
      }
    });

    const rootSeeds = treeNodes
      .filter((n) => nonSymInDeg[n.id] === 0)
      .sort((a, b) => (b.pointers?.length ?? 0) - (a.pointers?.length ?? 0));
    if (rootSeeds.length === 0 && treeNodes.length > 0) {
      rootSeeds.push(treeNodes[0]);
    }

    const bfsVisited = new Set<string>();
    const orientFromSeed = (seedId: string) => {
      const queue: string[] = [seedId];
      bfsVisited.add(seedId);

      while (queue.length > 0) {
        const u: string = queue.shift()!;
        const uNode = nodeMap.get(u);
        const selfOrder = uNode?.self_ref_order || [];

        const outEdges = validEdges.filter((e) => e.source === u);
        outEdges.forEach((e) => {
          if (!bfsVisited.has(e.target)) {
            bfsVisited.add(e.target);
            let slotIdx = e.field_order_idx ?? 0;
            if (e.label && selfOrder.includes(e.label)) {
              slotIdx = selfOrder.indexOf(e.label);
            }
            treeChildren.get(u)?.push({ childId: e.target, slotIdx });
            queue.push(e.target);
          }
        });
      }
    };

    rootSeeds.forEach((r) => {
      if (!bfsVisited.has(r.id)) orientFromSeed(r.id);
    });
    treeNodes.forEach((n) => {
      if (!bfsVisited.has(n.id)) orientFromSeed(n.id);
    });
  }

  treeChildren.forEach((list) => {
    list.sort((a, b) => a.slotIdx - b.slotIdx);
  });

  const childIdSet = new Set<string>();
  treeChildren.forEach((list) => {
    list.forEach((c) => childIdSet.add(c.childId));
  });

  const allRoots = treeNodes
    .filter((n) => !childIdSet.has(n.id))
    .map((n) => n.id);
  if (allRoots.length === 0 && treeNodes.length > 0) {
    allRoots.push(treeNodes[0].id);
  }

  const connectedRoots = allRoots.filter(
    (rId) => (treeChildren.get(rId)?.length ?? 0) > 0
  );
  const isolatedSingletons =
    connectedRoots.length > 0
      ? allRoots.filter((rId) => (treeChildren.get(rId)?.length ?? 0) === 0)
      : allRoots;

  const slotCardW = HEAP_CARD_WIDTH;
  const slotCardH = HEAP_CARD_MIN_HEIGHT;
  const UNIT_SLOT = slotCardW + effectiveNodeSep;
  const subtreeWidth = new Map<string, number>();
  const visitedWidth = new Set<string>();

  const computeWidth = (uId: string): number => {
    if (visitedWidth.has(uId)) {
      return subtreeWidth.get(uId) || UNIT_SLOT;
    }
    visitedWidth.add(uId);

    const uNode = nodeMap.get(uId);
    const isBinaryNode =
      (uNode?.self_ref_order?.length ?? 0) === 2 && !isParentPointerForest;
    const chList = treeChildren.get(uId) || [];

    let w = UNIT_SLOT;
    if (chList.length === 0) {
      w = UNIT_SLOT;
    } else if (isBinaryNode && chList.length === 1) {
      const childW = computeWidth(chList[0].childId);
      w = childW + UNIT_SLOT * 0.65;
    } else {
      let sum = 0;
      chList.forEach((c) => {
        sum += computeWidth(c.childId);
      });
      w = Math.max(UNIT_SLOT, sum);
    }

    subtreeWidth.set(uId, w);
    return w;
  };

  allRoots.forEach((rId) => computeWidth(rId));

  const assignCoords = (uId: string, centerX: number, centerY: number) => {
    positions[uId] = { x: Math.round(centerX), y: Math.round(centerY) };

    const uNode = nodeMap.get(uId);
    const uDim = nodeDims.get(uId) || {
      width: slotCardW,
      height: slotCardH,
    };
    const isBinaryNode =
      (uNode?.self_ref_order?.length ?? 0) === 2 && !isParentPointerForest;
    const chList = treeChildren.get(uId) || [];

    if (chList.length === 0) return;

    if (isBinaryNode && chList.length === 1) {
      const onlyChild = chList[0];
      const childDim = nodeDims.get(onlyChild.childId) || {
        width: slotCardW,
        height: slotCardH,
      };
      const childW = subtreeWidth.get(onlyChild.childId) || UNIT_SLOT;
      const offset = Math.max(145, childW * 0.35);
      const childCenterX =
        onlyChild.slotIdx === 0 ? centerX - offset : centerX + offset;
      const childCenterY =
        centerY + uDim.height / 2 + effectiveRankSep + childDim.height / 2;
      assignCoords(onlyChild.childId, childCenterX, childCenterY);
      return;
    }

    const totalW = chList.reduce(
      (acc, c) => acc + (subtreeWidth.get(c.childId) || UNIT_SLOT),
      0
    );
    let currentLeft = centerX - totalW / 2;

    chList.forEach((c) => {
      const cW = subtreeWidth.get(c.childId) || UNIT_SLOT;
      const childDim = nodeDims.get(c.childId) || {
        width: slotCardW,
        height: slotCardH,
      };
      const cCenterX = currentLeft + cW / 2;
      const cCenterY =
        centerY + uDim.height / 2 + effectiveRankSep + childDim.height / 2;
      assignCoords(c.childId, cCenterX, cCenterY);
      currentLeft += cW;
    });
  };

  const isMultiTreeContainer =
    containerNodes.length > 0 && allRoots.length >= 2;
  const baseRootY =
    containerNodes.length > 0 && !isMultiTreeContainer ? 280 : 130;
  let cursorX = isMultiTreeContainer
    ? 160 + HEAP_CARD_WIDTH + effectiveRankSep + 30
    : 160;

  connectedRoots.forEach((rId) => {
    const rW = subtreeWidth.get(rId) || UNIT_SLOT;
    assignCoords(rId, cursorX + rW / 2, baseRootY);
    cursorX += rW + effectiveNodeSep;
  });

  if (isolatedSingletons.length > 0) {
    const colsPerRow = connectedRoots.length > 0 ? 2 : 4;
    const startSingletonX =
      connectedRoots.length > 0 ? cursorX + 50 : cursorX;
    const pitchX = slotCardW + 65;
    const pitchY = slotCardH + 65;

    isolatedSingletons.forEach((sId, idx) => {
      const col = idx % colsPerRow;
      const row = Math.floor(idx / colsPerRow);
      positions[sId] = {
        x: Math.round(startSingletonX + col * pitchX),
        y: Math.round(baseRootY + row * pitchY),
      };
    });
  }

  if (containerNodes.length > 0) {
    containerNodes.forEach((cNode, cIdx) => {
      const cTargets = allValidEdges
        .filter((e) => e.source === cNode.id && positions[e.target] !== undefined)
        .map((e) => positions[e.target]);
      const cDim = nodeDims.get(cNode.id) || {
        width: HEAP_CARD_WIDTH,
        height: HEAP_CARD_MIN_HEIGHT,
      };

      if (isMultiTreeContainer && cTargets.length > 0) {
        const minY = Math.min(...cTargets.map((pos) => pos.y));
        const maxY = Math.max(...cTargets.map((pos) => pos.y));
        positions[cNode.id] = {
          x: 160,
          y: Math.round(
            (minY + maxY) / 2 + cIdx * (cDim.height + effectiveNodeSep)
          ),
        };
      } else if (cTargets.length > 0) {
        const avgX =
          cTargets.reduce((sum, pos) => sum + pos.x, 0) / cTargets.length;
        const minY = Math.min(...cTargets.map((pos) => pos.y));
        positions[cNode.id] = {
          x: Math.round(avgX + cIdx * 280),
          y: Math.round(minY - cDim.height / 2 - effectiveRankSep),
        };
      } else {
        positions[cNode.id] = {
          x: 160 + cIdx * 280,
          y: 90,
        };
      }
    });
  }

  return deoverlapNodePositions(positions, nodes, 36);
}

let isDagreRegistered = false;
function ensureDagreLayoutRegistered(): void {
  if (isDagreRegistered) return;
  try {
    function CustomDagreLayout(
      this: { options: CustomDagreLayoutOptions },
      options: CustomDagreLayoutOptions
    ) {
      this.options = options;
    }
    CustomDagreLayout.prototype.run = function (this: {
      options: CustomDagreLayoutOptions;
    }) {
      const options = this.options;
      const eles = options.eles;
      const cyNodes = eles.nodes();

      const rawNodes: ExtendedGraphNode[] = [];
      cyNodes.forEach((n) => {
        const raw = n.data("rawNode") as ExtendedGraphNode | undefined;
        if (raw) {
          rawNodes.push(raw);
        } else {
          rawNodes.push({
            id: n.id(),
            fields: {},
          });
        }
      });

      const rawEdges: ExtendedGraphEdge[] = [];
      eles.edges().forEach((e) => {
        const srcId = e.source().id();
        const tgtId = e.target().id();
        if (
          isValidEdgeEndpoint(srcId) &&
          isValidEdgeEndpoint(tgtId) &&
          srcId !== tgtId
        ) {
          rawEdges.push({
            source: srcId,
            target: tgtId,
            label: String(e.data("label") ?? ""),
            field_order_idx: Number(e.data("fieldOrderIdx") ?? 0),
          });
        }
      });

      const computed = computeDagreHierarchicalPositions(rawNodes, rawEdges, {
        rankDir: options.rankDir || "TB",
        align: options.align || "UL",
        nodeSep: Math.max(90, options.nodeSep ?? 90),
        rankSep: Math.max(110, options.rankSep ?? 110),
        edgeSep: options.edgeSep ?? 40,
      });

      cyNodes.layoutPositions(this, options, (ele) => {
        return computed[ele.id()] || ele.position();
      });
      return this;
    };

    cytoscape("layout", "dagre", CustomDagreLayout as unknown as cytoscape.Ext);
    isDagreRegistered = true;
  } catch {
    isDagreRegistered = true;
  }
}

/**
 * Builds an SVG memory card for a physical C struct node with robust quote-aware
 * field tokenization and discrete row placement.
 */
function buildSvgMemoryCard(node: ExtendedGraphNode): {
  svgDataUri: string;
  width: number;
  height: number;
} {
  const isFreed = Boolean(node.is_freed) || node.status === "freed";
  const isActive =
    (Array.isArray(node.pointers) && node.pointers.length > 0) ||
    Boolean(node.is_active);

  const rawType = (node.c_type || node.type || "struct")
    .replace(/^struct\s+/, "")
    .trim();
  const shortType = rawType.length > 14 ? `${rawType.slice(0, 13)}…` : rawType;

  const fieldRows: StructFieldRow[] = extractDiscreteFieldRows(node);
  const fieldCount = fieldRows.length;
  const headerHeight = 28;
  const rowHeight = 20;
  const calculatedWidth = HEAP_CARD_WIDTH;
  const calculatedHeight = Math.max(
    HEAP_CARD_MIN_HEIGHT,
    headerHeight + 16 + Math.max(1, fieldCount) * rowHeight
  );

  const borderColor = isFreed
    ? "#ef4444"
    : isActive
    ? "#38bdf8"
    : "#475569";
  const headerBg = isFreed
    ? "#450a0a"
    : isActive
    ? "#0c4a6e"
    : "#1e293b";
  const bodyBg = isFreed ? "#18181b" : "#0f172a";
  const dotColor = isFreed
    ? "#f87171"
    : isActive
    ? "#38bdf8"
    : "#94a3b8";
  const dashAttr = isFreed ? 'stroke-dasharray="6,4"' : "";

  let rowsSvg = "";
  if (fieldCount === 0) {
    const fallbackText = escapeXml(node.label || "(empty)");
    rowsSvg += `<text x="12" y="${
      headerHeight + 22
    }" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#94a3b8">${fallbackText}</text>`;
  } else {
    fieldRows.forEach(({ key, value }, idx) => {
      const rowTopY = headerHeight + 4 + idx * rowHeight;
      const baselineY = rowTopY + 14;
      const keyText = escapeXml(
        key.length > 12 ? `${key.slice(0, 11)}…` : key
      );
      const rawValStr = value.trim();

      const isNullPointerField =
        rawValStr === "NULL" ||
        rawValStr === "0x0" ||
        rawValStr === "0X0" ||
        rawValStr === "(nil)";

      let formattedVal = rawValStr;
      let valColor = "#34d399";

      if (isNullPointerField) {
        formattedVal = "⏚ NULL";
        valColor = "#64748b";
      } else if (rawValStr.startsWith("0x") && rawValStr.length > 4) {
        formattedVal = `→ ${rawValStr.slice(-6)}`;
        valColor = "#fbbf24";
      } else if (rawValStr.startsWith("ptr[")) {
        valColor = "#38bdf8";
      }

      if (formattedVal.length > 16) {
        formattedVal = `${formattedVal.slice(0, 15)}…`;
      }

      const strikeAttr = isFreed ? 'text-decoration="line-through"' : "";
      const valRightX = isNullPointerField
        ? calculatedWidth - 17
        : calculatedWidth - 12;

      const rowDividerSvg =
        idx > 0
          ? `<line x1="8" y1="${rowTopY}" x2="${
              calculatedWidth - 8
            }" y2="${rowTopY}" stroke="#1e293b" stroke-width="1"/>`
          : "";

      const groundPinSvg = isNullPointerField
        ? `<circle cx="${calculatedWidth - 9}" cy="${
            baselineY - 3.5
          }" r="2.4" fill="#1e293b" stroke="#64748b" stroke-width="1.2"/>`
        : "";

      rowsSvg += `
        <g>
          ${rowDividerSvg}
          <text x="12" y="${baselineY}" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="600" fill="${
            isFreed ? "#f87171" : "#38bdf8"
          }">${keyText}:</text>
          <text x="${valRightX}" y="${baselineY}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" ${strikeAttr} fill="${
            isFreed ? "#fca5a5" : valColor
          }">${escapeXml(formattedVal)}</text>
          ${groundPinSvg}
        </g>
      `;
    });
  }

  const shortAddr =
    node.id.length > 10 ? `0x…${node.id.slice(-6)}` : node.id;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${calculatedWidth}" height="${calculatedHeight}" viewBox="0 0 ${calculatedWidth} ${calculatedHeight}">
    <rect x="1.5" y="1.5" width="${calculatedWidth - 3}" height="${
    calculatedHeight - 3
  }" rx="7" fill="${bodyBg}" stroke="${borderColor}" stroke-width="2" ${dashAttr}/>
    <path d="M 3 8.5 Q 3 3 8.5 3 L ${calculatedWidth - 8.5} 3 Q ${
    calculatedWidth - 3
  } 3 ${calculatedWidth - 3} 8.5 L ${
    calculatedWidth - 3
  } ${headerHeight} L 3 ${headerHeight} Z" fill="${headerBg}"/>
    <line x1="2" y1="${headerHeight}" x2="${
    calculatedWidth - 2
  }" y2="${headerHeight}" stroke="${borderColor}" stroke-width="1.2"/>
    <circle cx="12" cy="${headerHeight / 2 + 0.5}" r="3.2" fill="${dotColor}"/>
    <text x="20" y="${
      headerHeight / 2 + 4
    }" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700" fill="#f8fafc">${escapeXml(
    shortAddr
  )}</text>
    <text x="${calculatedWidth - 10}" y="${
    headerHeight / 2 + 3.5
  }" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600" fill="${
    isFreed ? "#fecaca" : "#bae6fd"
  }">[${escapeXml(isFreed ? "FREED" : shortType)}]</text>
    ${rowsSvg}
  </svg>`;

  return {
    svgDataUri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    width: calculatedWidth,
    height: calculatedHeight,
  };
}

/**
 * Builds an SVG circular vertex card (`70x70`) matching the exact `node[?isLogicalVertex]`
 * stylesheet footprint so Cytoscape arrow tips terminate proud of the outer ring.
 */
function buildSvgVertexCard(
  vertexIndex: number | string,
  metricLabel: string | null,
  isActive: boolean,
  isSettled: boolean
): { svgDataUri: string; width: number; height: number } {
  const size = LOGICAL_VERTEX_SIZE;
  const borderColor = isActive
    ? "#f59e0b"
    : isSettled
    ? "#10b981"
    : "#38bdf8";
  const bgFill = isActive
    ? "#082f49"
    : isSettled
    ? "#022c22"
    : "#0f172a";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${
    size / 2 - 2.5
  }" fill="${bgFill}" stroke="${borderColor}" stroke-width="3"/>
    <text x="${size / 2}" y="${
    metricLabel ? 31 : 39
  }" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12" font-weight="800" fill="#f8fafc">Node ${escapeXml(
    String(vertexIndex)
  )}</text>
    ${
      metricLabel
        ? `<text x="${
            size / 2
          }" y="48" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" fill="#34d399">${escapeXml(
            metricLabel
          )}</text>`
        : ""
    }
  </svg>`;

  return {
    svgDataUri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    width: size,
    height: size,
  };
}

interface DiscoveredPhysicalEdge {
  u: number;
  v: number;
  edgeFieldLabel: string;
  metricValues: number[];
  chainNodeId: string;
  isActiveTraversal: boolean;
  traversalPtrs: string[];
}

function projectLogicalGraphFromMesh(
  physicalGraph: ExtendedGraphData,
  explicitLogicalGraph: LogicalGraphPayload | null | undefined,
  locals: Record<string, number | string> | undefined,
  arrays: ArraySnapshot[] | undefined,
  knownMetricVars: Set<string>,
  knownVertexVars: Set<string>
): {
  canProject: boolean;
  isForestTopology: boolean;
  logicalGraph: ExtendedGraphData;
} {
  const backendLogical = explicitLogicalGraph ?? physicalGraph?.logical_graph;
  const pNodes = (physicalGraph?.nodes || []) as ExtendedGraphNode[];
  const pEdges = ((physicalGraph?.edges || []) as ExtendedGraphEdge[]).filter(
    (e) => isValidGraphEdge(e)
  );

  // Case 1: Index-Buffer Forest Topology (e.g., 1D `int parent[]` array)
  if (
    (backendLogical && backendLogical.is_forest) ||
    (pNodes.length > 0 && pNodes.every((n) => n.type === "IndexNode"))
  ) {
    const sourceNodes =
      backendLogical && backendLogical.nodes.length > 0
        ? backendLogical.nodes
        : pNodes;
    const sourceEdges = (
      backendLogical && backendLogical.edges.length > 0
        ? backendLogical.edges
        : pEdges
    )
      .filter((e) => isValidGraphEdge(e, undefined, true))
      .map((e) => ({
        ...e,
        label: resolveEdgeFieldLabel(e),
        base_label: resolveEdgeFieldLabel(e),
        directed: true,
      }));

    const logicalNodes: ExtendedGraphNode[] = sourceNodes
      .filter(
        (n) =>
          isValidEdgeEndpoint(n.id) && !n.is_freed && n.status !== "freed"
      )
      .map((n, idx) => {
        if (n.type === "IndexNode") {
          const idxNum = n.fields?.index ?? idx;
          const entries = Object.entries(n.fields || {}).filter(
            ([k]) => k !== "index" && k !== "role"
          );
          const targetVal = entries.length > 0 ? entries[0][1] : idxNum;
          const fieldKeyName = entries.length > 0 ? entries[0][0] : "→";
          return {
            ...n,
            type: "LogicalVertex",
            label: `Node ${idxNum}`,
            fields: {
              vertex: idxNum,
              [fieldKeyName]: targetVal,
            },
          };
        }
        return n;
      });

    return {
      canProject: logicalNodes.length > 0,
      isForestTopology: true,
      logicalGraph: {
        nodes: logicalNodes,
        edges: sourceEdges,
      },
    };
  }

  const nodeById = new Map<string, ExtendedGraphNode>();
  pNodes.forEach((n) => {
    if (isValidEdgeEndpoint(n.id)) {
      nodeById.set(n.id, n);
    }
  });

  const outgoingBySource = new Map<string, ExtendedGraphEdge[]>();
  pEdges.forEach((e) => {
    if (!outgoingBySource.has(e.source)) {
      outgoingBySource.set(e.source, []);
    }
    outgoingBySource.get(e.source)!.push(e);
  });

  // Case 1.5: Direct Struct-Pointer Table (e.g., `UFNode **nodes`)
  const directTableAddrToIndex = new Map<string, number>();
  const directTableIndexToNode = new Map<number, ExtendedGraphNode>();

  pNodes.forEach((n) => {
    if (n.is_freed || n.status === "freed") return;
    (n.pointers || []).forEach((ptrTag) => {
      const cleanTag = ptrTag.split(":").pop() || ptrTag;
      const m = INDEXED_EDGE_RE.exec(cleanTag);
      if (m) {
        const idx = Number(m[2]);
        directTableAddrToIndex.set(n.id, idx);
        directTableIndexToNode.set(idx, n);
      }
    });
  });

  let containerNode: ExtendedGraphNode | undefined;
  let indexedEdges: Array<{ uIdx: number; targetId: string }> = [];

  for (const n of pNodes) {
    if (n.is_freed || n.status === "freed") continue;
    const out = outgoingBySource.get(n.id) || [];
    const matched = out
      .map((e) => {
        if (!isValidEdgeEndpoint(e.target)) return null;
        const m = INDEXED_EDGE_RE.exec(e.label || "");
        return m ? { uIdx: Number(m[2]), targetId: e.target } : null;
      })
      .filter((x): x is { uIdx: number; targetId: string } => x !== null);

    if (matched.length > 0) {
      containerNode = n;
      indexedEdges = matched;
      break;
    }

    const hasPtrArraySummary = Object.values(n.fields || {}).some(
      (v) => typeof v === "string" && v.startsWith("ptr[")
    );
    if (hasPtrArraySummary) {
      containerNode = n;
    }
  }

  const indexedTargetAddrToIndex = new Map<string, number>();
  indexedEdges.forEach(({ uIdx, targetId }) => {
    indexedTargetAddrToIndex.set(targetId, uIdx);
  });

  const isContainerOfDirectVertexStructs =
    indexedEdges.length > 0 &&
    pEdges.some(
      (e) =>
        indexedTargetAddrToIndex.has(e.source) &&
        indexedTargetAddrToIndex.has(e.target)
    );

  if (
    directTableAddrToIndex.size >= 2 ||
    isContainerOfDirectVertexStructs
  ) {
    const addrToIdx =
      directTableAddrToIndex.size >= 2
        ? directTableAddrToIndex
        : indexedTargetAddrToIndex;

    let maxIdx = 0;
    addrToIdx.forEach((idx) => {
      if (idx + 1 > maxIdx) maxIdx = idx + 1;
    });

    const logicalNodes: ExtendedGraphNode[] = [];
    for (let i = 0; i < maxIdx; i++) {
      const physNode =
        directTableIndexToNode.get(i) ||
        pNodes.find((n) => addrToIdx.get(n.id) === i);

      const nonTablePtrs = (physNode?.pointers || []).filter((p) => {
        const clean = p.split(":").pop() || p;
        return !INDEXED_EDGE_RE.test(clean);
      });

      const fieldsObj: Record<string, number | string> = { vertex: i };
      let metricSummary: string | null = null;

      if (physNode) {
        Object.entries(physNode.fields || {}).forEach(([k, v]) => {
          const sVal = String(v).trim();
          if (
            !isNullAddressToken(sVal) &&
            !sVal.startsWith("0x") &&
            !sVal.startsWith("0X") &&
            !sVal.startsWith("ptr[")
          ) {
            fieldsObj[k] = v as number | string;
            if (Number(v) !== i && metricSummary === null) {
              metricSummary = `${k}: ${sVal}`;
            }
          }
        });
      }

      logicalNodes.push({
        id: `vertex-${i}`,
        type: "LogicalVertex",
        c_type: physNode?.c_type || "Vertex",
        label: metricSummary ? `Node ${i} (${metricSummary})` : `Node ${i}`,
        status: "active",
        fields: fieldsObj,
        pointers: nonTablePtrs,
        is_active: nonTablePtrs.length > 0,
        is_freed: false,
      });
    }

    const logicalEdges: ExtendedGraphEdge[] = [];
    pEdges.forEach((e) => {
      const uIdx = addrToIdx.get(e.source);
      const vIdx = addrToIdx.get(e.target);
      if (uIdx !== undefined && vIdx !== undefined && uIdx !== vIdx) {
        const fieldName = resolveEdgeFieldLabel(e);
        logicalEdges.push({
          source: `vertex-${uIdx}`,
          target: `vertex-${vIdx}`,
          label: fieldName,
          base_label: fieldName,
          fieldName,
          field_order_idx: e.field_order_idx ?? 0,
          directed: true,
        });
      }
    });

    return {
      canProject: logicalNodes.length > 0,
      isForestTopology: true,
      logicalGraph: {
        nodes: logicalNodes,
        edges: logicalEdges,
      },
    };
  }

  // Case 2: Adjacency-List Graph Projection (`container -> adj[u] -> EdgeNode chain`)
  let vertexCount =
    backendLogical && Array.isArray(backendLogical.nodes)
      ? backendLogical.nodes.length
      : 0;

  if (containerNode) {
    Object.values(containerNode.fields || {}).forEach((val) => {
      if (typeof val === "number" && val >= 1 && val <= 32) {
        vertexCount = Math.max(vertexCount, val);
      } else if (typeof val === "string" && val.startsWith("ptr[")) {
        const m = /^ptr\[(\d+)\]/.exec(val);
        if (m) {
          vertexCount = Math.max(vertexCount, Number(m[1]));
        }
      }
    });
  }

  indexedEdges.forEach((ie) => {
    vertexCount = Math.max(vertexCount, ie.uIdx + 1);
  });

  if (vertexCount <= 0 || vertexCount > 32) {
    return {
      canProject: false,
      isForestTopology: false,
      logicalGraph: { nodes: [], edges: [] },
    };
  }

  const addrToLocalPtrNames = new Map<string, string[]>();
  const scalarLocals = new Map<string, number>();

  if (locals) {
    Object.entries(locals).forEach(([varName, rawVal]) => {
      const strVal = String(rawVal).trim();
      if (
        (strVal.startsWith("0x") || strVal.startsWith("0X")) &&
        !isNullAddressToken(strVal)
      ) {
        const normAddr = strVal.toLowerCase();
        if (!addrToLocalPtrNames.has(normAddr)) {
          addrToLocalPtrNames.set(normAddr, []);
        }
        addrToLocalPtrNames.get(normAddr)!.push(varName);
      } else if (strVal === "∞" || strVal === "-∞") {
        knownMetricVars.add(varName);
      } else if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
        scalarLocals.set(varName, rawVal);
        if (rawVal > vertexCount || rawVal < -1) {
          knownMetricVars.add(varName);
        }
      } else if (/^-?\d+(\.\d+)?$/.test(strVal)) {
        const num = Number(strVal);
        if (Number.isFinite(num)) {
          scalarLocals.set(varName, num);
          if (num > vertexCount || num < -1) {
            knownMetricVars.add(varName);
          }
        }
      }
    });
  }

  const discoveredEdges: DiscoveredPhysicalEdge[] = [];

  for (const { uIdx, targetId } of indexedEdges) {
    let currId: string | undefined = targetId;
    const visitedChain = new Set<string>();

    while (
      currId &&
      isValidEdgeEndpoint(currId) &&
      !visitedChain.has(currId) &&
      visitedChain.size < 32
    ) {
      visitedChain.add(currId);
      const chainNode = nodeById.get(currId);
      if (!chainNode) break;

      const isChainNodeFreed =
        Boolean(chainNode.is_freed) || chainNode.status === "freed";

      if (!isChainNodeFreed) {
        const scalarFields: Array<[string, number | string]> = [];
        const pointerFieldNames: string[] = [];

        Object.entries(chainNode.fields || {}).forEach(([k, val]) => {
          const sVal = String(val).trim();
          if (
            !isNullAddressToken(sVal) &&
            !sVal.startsWith("0x") &&
            !sVal.startsWith("0X") &&
            !sVal.startsWith("ptr[")
          ) {
            scalarFields.push([k, val]);
          } else {
            pointerFieldNames.push(k);
          }
        });

        const outEdgesForNode: ExtendedGraphEdge[] =
          outgoingBySource.get(currId) || [];
        const directTargetEdge = outEdgesForNode.find((oe) =>
          indexedTargetAddrToIndex.has(oe.target)
        );

        if (directTargetEdge) {
          const destVertexIdx = indexedTargetAddrToIndex.get(
            directTargetEdge.target
          )!;
          if (uIdx !== destVertexIdx) {
            const ptrFieldName = resolveEdgeFieldLabel(directTargetEdge);
            discoveredEdges.push({
              u: uIdx,
              v: destVertexIdx,
              edgeFieldLabel: ptrFieldName,
              metricValues: [],
              chainNodeId: currId,
              isActiveTraversal: false,
              traversalPtrs: [],
            });
          }
          break;
        }

        if (scalarFields.length >= 1) {
          const destVal = Number(scalarFields[0][1]);
          const secondFieldLabel =
            scalarFields.length >= 2
              ? `${scalarFields[1][0]}: ${String(scalarFields[1][1])}`
              : pointerFieldNames[0] || "";

          const metricValues: number[] = scalarFields
            .slice(1)
            .map(([, mv]) => Number(mv))
            .filter((n) => Number.isFinite(n));

          const directPtrs = new Set<string>();
          (chainNode.pointers || []).forEach((pName) => {
            const cleanPtr = pName.split(":").pop() || pName;
            if (!cleanPtr.includes("->") && !cleanPtr.includes("[")) {
              directPtrs.add(cleanPtr);
            }
          });
          const localAddrPtrs =
            addrToLocalPtrNames.get(chainNode.id.toLowerCase()) || [];
          localAddrPtrs.forEach((pName) => directPtrs.add(pName));

          if (
            Number.isInteger(destVal) &&
            destVal >= 0 &&
            destVal < vertexCount &&
            destVal !== uIdx
          ) {
            discoveredEdges.push({
              u: uIdx,
              v: destVal,
              edgeFieldLabel: secondFieldLabel,
              metricValues,
              chainNodeId: currId,
              isActiveTraversal: directPtrs.size > 0,
              traversalPtrs: Array.from(directPtrs),
            });
          }
        }
      }

      const outEdges: ExtendedGraphEdge[] = outgoingBySource.get(currId) || [];
      const nextOut: ExtendedGraphEdge | undefined = outEdges.find((oe) =>
        isValidEdgeEndpoint(oe.target)
      );
      currId = nextOut ? nextOut.target : undefined;
    }
  }

  const vertexDomainArrays: ArraySnapshot[] = (arrays || []).filter(
    (a) =>
      !a.is_compound && a.kind !== "matrix" && a.elements.length === vertexCount
  );
  const primaryMetricArray: ArraySnapshot | undefined = vertexDomainArrays[0];

  const candidateVertexVars = new Map<string, number>();
  vertexDomainArrays.forEach((vArr) => {
    Object.entries(vArr.active_indices || {}).forEach(([varName, idxVal]) => {
      if (
        typeof idxVal === "number" &&
        Number.isInteger(idxVal) &&
        idxVal >= 0 &&
        idxVal < vertexCount &&
        !knownMetricVars.has(varName)
      ) {
        if (!candidateVertexVars.has(varName)) {
          candidateVertexVars.set(varName, idxVal);
        }
      }
    });
  });

  const activePhysicalEdge: DiscoveredPhysicalEdge | undefined =
    discoveredEdges.find((de) => de.isActiveTraversal);

  let activeEdgeMetricBinding: {
    u: number;
    v: number;
    varName: string;
    varVal: number | string;
  } | null = null;

  const vertexPointers: Record<number, string[]> = {};

  if (activePhysicalEdge) {
    const { u: actU, v: actV, metricValues } = activePhysicalEdge;

    let chosenUVar: string | null = null;
    candidateVertexVars.forEach((val, varName) => {
      if (val === actU && !knownMetricVars.has(varName)) {
        if (
          chosenUVar === null ||
          (knownVertexVars.has(varName) && !knownVertexVars.has(chosenUVar))
        ) {
          chosenUVar = varName;
        }
      }
    });
    if (chosenUVar !== null) {
      knownVertexVars.add(chosenUVar);
      vertexPointers[actU] = [chosenUVar];
    }

    let chosenVVar: string | null = null;
    candidateVertexVars.forEach((val, varName) => {
      if (
        val === actV &&
        varName !== chosenUVar &&
        !knownMetricVars.has(varName)
      ) {
        if (chosenVVar === null) {
          chosenVVar = varName;
        } else if (
          knownVertexVars.has(varName) &&
          !knownVertexVars.has(chosenVVar)
        ) {
          knownMetricVars.add(chosenVVar);
          chosenVVar = varName;
        } else {
          knownMetricVars.add(varName);
        }
      }
    });
    if (chosenVVar !== null) {
      knownVertexVars.add(chosenVVar);
      if (!vertexPointers[actV]) {
        vertexPointers[actV] = [];
      }
      if (!vertexPointers[actV].includes(chosenVVar)) {
        vertexPointers[actV].push(chosenVVar);
      }
    }

    scalarLocals.forEach((val, varName) => {
      if (varName !== chosenUVar && varName !== chosenVVar) {
        if (metricValues.includes(val)) {
          knownMetricVars.add(varName);
        }
      }
    });

    let boundMetricVarName: string | null = null;
    let boundMetricVarVal: number | null = null;
    scalarLocals.forEach((val, varName) => {
      if (
        varName !== chosenUVar &&
        varName !== chosenVVar &&
        !knownVertexVars.has(varName) &&
        metricValues.includes(val)
      ) {
        boundMetricVarName = varName;
        boundMetricVarVal = val;
      }
    });

    if (boundMetricVarName !== null && boundMetricVarVal !== null) {
      activeEdgeMetricBinding = {
        u: actU,
        v: actV,
        varName: boundMetricVarName,
        varVal: boundMetricVarVal,
      };
    }

    activePhysicalEdge.traversalPtrs.forEach((pName) => {
      const tag = `${pName}→`;
      if (!vertexPointers[actV]) {
        vertexPointers[actV] = [];
      }
      if (!vertexPointers[actV].includes(tag)) {
        vertexPointers[actV].push(tag);
      }
    });
  } else {
    candidateVertexVars.forEach((idxVal, varName) => {
      if (knownMetricVars.has(varName)) {
        return;
      }
      if (!vertexPointers[idxVal]) {
        vertexPointers[idxVal] = [];
      }
      if (!vertexPointers[idxVal].includes(varName)) {
        vertexPointers[idxVal].push(varName);
      }
    });
  }

  const logicalNodes: ExtendedGraphNode[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const ptrs = vertexPointers[i] || [];
    const metricVal =
      primaryMetricArray && i < primaryMetricArray.elements.length
        ? primaryMetricArray.elements[i]
        : undefined;

    const fieldsObj: Record<string, number | string> = { vertex: i };
    let metricLabel: string | null = null;

    if (
      metricVal !== undefined &&
      (typeof metricVal === "number" || typeof metricVal === "string")
    ) {
      fieldsObj[primaryMetricArray!.name] = metricVal;
      metricLabel = `${primaryMetricArray!.name}: ${String(metricVal)}`;
    }

    logicalNodes.push({
      id: `vertex-${i}`,
      type: "LogicalVertex",
      c_type: "Vertex",
      label: metricLabel ? `Node ${i} (${metricLabel})` : `Node ${i}`,
      status: "active",
      fields: fieldsObj,
      pointers: ptrs,
      is_active: ptrs.length > 0,
      is_freed: false,
    });
  }

  const logicalEdges: ExtendedGraphEdge[] = [];

  if (discoveredEdges.length > 0) {
    discoveredEdges.forEach((de) => {
      if (de.u === de.v) return;
      const baseLabel = de.edgeFieldLabel;
      let displayLabel = baseLabel;
      const hasActiveMetric = de.isActiveTraversal && baseLabel !== "";

      if (
        de.isActiveTraversal &&
        activeEdgeMetricBinding &&
        activeEdgeMetricBinding.u === de.u &&
        activeEdgeMetricBinding.v === de.v
      ) {
        displayLabel =
          baseLabel !== ""
            ? `${baseLabel} (${activeEdgeMetricBinding.varName} = ${activeEdgeMetricBinding.varVal})`
            : `${activeEdgeMetricBinding.varName} = ${activeEdgeMetricBinding.varVal}`;
      }

      logicalEdges.push({
        source: `vertex-${de.u}`,
        target: `vertex-${de.v}`,
        label: displayLabel,
        base_label: baseLabel,
        fieldName: baseLabel,
        is_active_edge: de.isActiveTraversal,
        has_active_metric: hasActiveMetric,
        directed: true,
      });
    });
  } else if (backendLogical && Array.isArray(backendLogical.edges)) {
    backendLogical.edges.forEach((be) => {
      if (!isValidGraphEdge(be, undefined, true)) return;
      const rawLabel = resolveEdgeFieldLabel(be);
      const cleanLabel = rawLabel.startsWith("w:") ? "" : rawLabel;
      logicalEdges.push({
        source: be.source,
        target: be.target,
        label: cleanLabel,
        base_label: cleanLabel,
        fieldName: cleanLabel,
        is_active_edge: false,
        has_active_metric: false,
        directed: true,
      });
    });
  }

  return {
    canProject: true,
    isForestTopology: true,
    logicalGraph: {
      nodes: logicalNodes,
      edges: logicalEdges,
    },
  };
}

function computeGeneralMeshSeedPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const nodeMap = new Map<string, ExtendedGraphNode>();
  const nodeHeights = new Map<string, number>();

  nodes.forEach((n) => {
    if (!isValidEdgeEndpoint(n.id)) return;
    nodeMap.set(n.id, n);
    const dim = getEstimatedNodeDimensions(n);
    nodeHeights.set(n.id, dim.height);
  });

  const inDegree: Record<string, number> = {};
  const adj: Record<string, ExtendedGraphEdge[]> = {};

  nodes.forEach((n) => {
    inDegree[n.id] = 0;
    adj[n.id] = [];
  });

  edges.forEach((e) => {
    if (
      isValidEdgeEndpoint(e.source) &&
      isValidEdgeEndpoint(e.target) &&
      nodeMap.has(e.source) &&
      nodeMap.has(e.target) &&
      e.source !== e.target
    ) {
      adj[e.source].push(e);
      inDegree[e.target] = (inDegree[e.target] || 0) + 1;
    }
  });

  const roots = nodes
    .filter((n) => inDegree[n.id] === 0)
    .map((n) => n.id);
  if (roots.length === 0) {
    roots.push(nodes[0].id);
  }

  const visited = new Set<string>();
  let currentLaneY = 130;
  const HORIZONTAL_PITCH = 330;
  const VERTICAL_MARGIN = 105;

  roots.forEach((rootId) => {
    if (visited.has(rootId)) return;
    visited.add(rootId);

    const rootOut = adj[rootId] || [];
    const rootHeight = nodeHeights.get(rootId) || HEAP_CARD_MIN_HEIGHT;

    if (rootOut.length === 0) {
      positions[rootId] = { x: 160, y: currentLaneY + rootHeight / 2 };
      currentLaneY += rootHeight + VERTICAL_MARGIN;
      return;
    }

    const startGroupY = currentLaneY;

    rootOut.forEach((branchEdge) => {
      let currId: string | undefined = branchEdge.target;
      let depthX = 1;
      let maxRowHeight = HEAP_CARD_MIN_HEIGHT;

      while (currId && isValidEdgeEndpoint(currId) && !visited.has(currId)) {
        visited.add(currId);
        const currH = nodeHeights.get(currId) || HEAP_CARD_MIN_HEIGHT;
        maxRowHeight = Math.max(maxRowHeight, currH);

        positions[currId] = {
          x: 160 + depthX * HORIZONTAL_PITCH,
          y: currentLaneY + currH / 2,
        };
        const nextEdges: ExtendedGraphEdge[] = adj[currId] || [];
        const firstNext: ExtendedGraphEdge | undefined = nextEdges.find((ne) =>
          isValidEdgeEndpoint(ne.target)
        );
        currId = firstNext ? firstNext.target : undefined;
        depthX += 1;
      }

      currentLaneY += maxRowHeight + VERTICAL_MARGIN;
    });

    const endGroupY = Math.max(
      startGroupY + rootHeight,
      currentLaneY - VERTICAL_MARGIN
    );
    positions[rootId] = {
      x: 160,
      y: (startGroupY + endGroupY) / 2,
    };

    currentLaneY += 50;
  });

  let leftoverIdx = 0;
  nodes.forEach((n) => {
    if (!visited.has(n.id)) {
      const h = nodeHeights.get(n.id) || HEAP_CARD_MIN_HEIGHT;
      positions[n.id] = {
        x: 160 + (leftoverIdx % 3) * HORIZONTAL_PITCH,
        y: currentLaneY + Math.floor(leftoverIdx / 3) * (h + VERTICAL_MARGIN),
      };
      leftoverIdx += 1;
    }
  });

  return deoverlapNodePositions(positions, nodes, 36);
}

export const GraphVisualizer: React.FC<GraphVisualizerProps> = ({
  graph,
  logicalGraph: explicitLogicalGraph,
  locals,
  arrays,
  isConnecting = false,
}) => {
  ensureDagreLayoutRegistered();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const prevTopologyKeyRef = useRef<string>("");
  const prevModeRef = useRef<ViewMode>("logical");
  const prevLayoutModeRef = useRef<LayoutMode>("auto");
  const userDraggedPositionsRef = useRef<
    Record<string, { x: number; y: number }>
  >({});

  const retainedNodesRef = useRef<Map<string, RetainedNodeEntry>>(new Map());
  const retainedEdgesRef = useRef<Map<string, RetainedEdgeEntry>>(new Map());
  const explicitFreedIdsRef = useRef<Set<string>>(new Set());

  const knownMetricVarsRef = useRef<Set<string>>(new Set<string>());
  const knownVertexVarsRef = useRef<Set<string>>(new Set<string>());

  const [viewMode, setViewMode] = useState<ViewMode>("logical");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("auto");
  const [isLayoutDropdownOpen, setIsLayoutDropdownOpen] =
    useState<boolean>(false);
  const [selectedNode, setSelectedNode] = useState<ExtendedGraphNode | null>(
    null
  );
  const [badgeOverlays, setBadgeOverlays] = useState<BadgeOverlayItem[]>([]);

  if (isConnecting) {
    knownMetricVarsRef.current.clear();
    knownVertexVarsRef.current.clear();
    retainedNodesRef.current.clear();
    retainedEdgesRef.current.clear();
    explicitFreedIdsRef.current.clear();
  }

  // Close layout dropdown on outside click
  useEffect(() => {
    if (!isLayoutDropdownOpen) return;
    const handleOutsideClick = (evt: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(evt.target as Node)
      ) {
        setIsLayoutDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isLayoutDropdownOpen]);

  const { canProject, isForestTopology, logicalGraph } = useMemo(
    () =>
      projectLogicalGraphFromMesh(
        graph,
        explicitLogicalGraph,
        locals,
        arrays,
        knownMetricVarsRef.current,
        knownVertexVarsRef.current
      ),
    [graph, explicitLogicalGraph, locals, arrays]
  );

  const effectiveMode: ViewMode =
    viewMode === "logical" && canProject ? "logical" : "physical";

  const activeGraphData: ExtendedGraphData =
    effectiveMode === "logical" ? logicalGraph : graph;

  const rawIncomingNodes: ExtendedGraphNode[] = useMemo(
    () =>
      (activeGraphData?.nodes || []).filter((n) => isValidEdgeEndpoint(n.id)),
    [activeGraphData]
  );

  const rawIncomingEdges: ExtendedGraphEdge[] = useMemo(
    () =>
      (activeGraphData?.edges || []).filter((e) =>
        isValidGraphEdge(e, undefined, effectiveMode === "logical")
      ),
    [activeGraphData, effectiveMode]
  );

  const { nodes, edges } = useMemo(() => {
    if (isConnecting) {
      return { nodes: [], edges: [] };
    }

    if (effectiveMode === "logical") {
      const validLogicalIds = new Set<string>(
        rawIncomingNodes.map((n) => n.id)
      );
      return {
        nodes: rawIncomingNodes,
        edges: rawIncomingEdges.filter((e) =>
          isValidGraphEdge(e, validLogicalIds, true)
        ),
      };
    }

    const incomingNodeMap = new Map<string, ExtendedGraphNode>();
    rawIncomingNodes.forEach((n) => {
      incomingNodeMap.set(n.id, n);
      if (Boolean(n.is_freed) || n.status === "freed") {
        explicitFreedIdsRef.current.add(n.id);
      } else {
        explicitFreedIdsRef.current.delete(n.id);
      }
    });

    const nextRetainedNodes = new Map<string, RetainedNodeEntry>();

    rawIncomingNodes.forEach((n) => {
      const prevEntry = retainedNodesRef.current.get(n.id);
      nextRetainedNodes.set(n.id, {
        node: { ...n, is_transient_retained: false },
        missingFrames: 0,
        lastPosition: prevEntry?.lastPosition,
      });
    });

    if (rawIncomingNodes.length > 0 || retainedNodesRef.current.size > 0) {
      retainedNodesRef.current.forEach((entry, nodeId) => {
        if (incomingNodeMap.has(nodeId)) return;
        const wasFreed =
          Boolean(entry.node.is_freed) ||
          entry.node.status === "freed" ||
          explicitFreedIdsRef.current.has(nodeId);
        if (wasFreed) {
          return;
        }
        const nextMissing = entry.missingFrames + 1;
        if (nextMissing <= TRANSIENT_NODE_GRACE_FRAMES) {
          nextRetainedNodes.set(nodeId, {
            node: {
              ...entry.node,
              pointers: [],
              is_active: false,
              is_transient_retained: true,
            },
            missingFrames: nextMissing,
            lastPosition: entry.lastPosition,
          });
        }
      });
    }

    retainedNodesRef.current = nextRetainedNodes;
    const stabilizedNodes = Array.from(nextRetainedNodes.values()).map(
      (entry) => entry.node
    );
    const stabilizedNodeIds = new Set<string>(
      stabilizedNodes.map((n) => n.id)
    );

    const nextRetainedEdges = new Map<string, RetainedEdgeEntry>();
    const makeEdgeKey = (e: ExtendedGraphEdge) =>
      `${e.source}->${e.target}:${resolveEdgeFieldLabel(e)}`;

    rawIncomingEdges.forEach((e) => {
      if (isValidGraphEdge(e, stabilizedNodeIds)) {
        nextRetainedEdges.set(makeEdgeKey(e), {
          edge: e,
          missingFrames: 0,
        });
      }
    });

    retainedEdgesRef.current.forEach((eEntry, eKey) => {
      if (nextRetainedEdges.has(eKey)) return;
      const e = eEntry.edge;
      if (!isValidGraphEdge(e, stabilizedNodeIds)) return;

      const srcRetained = nextRetainedNodes.get(e.source);
      const tgtRetained = nextRetainedNodes.get(e.target);
      const involvesTransientNode =
        Boolean(srcRetained && srcRetained.missingFrames > 0) ||
        Boolean(tgtRetained && tgtRetained.missingFrames > 0);

      if (
        involvesTransientNode &&
        eEntry.missingFrames + 1 <= TRANSIENT_NODE_GRACE_FRAMES
      ) {
        nextRetainedEdges.set(eKey, {
          edge: e,
          missingFrames: eEntry.missingFrames + 1,
        });
      }
    });

    retainedEdgesRef.current = nextRetainedEdges;
    const stabilizedEdges = Array.from(nextRetainedEdges.values()).map(
      (entry) => entry.edge
    );

    return {
      nodes: stabilizedNodes,
      edges: stabilizedEdges,
    };
  }, [
    isConnecting,
    effectiveMode,
    rawIncomingNodes,
    rawIncomingEdges,
  ]);

  const detectedTopology = useMemo<GraphTopologyKind>(
    () => detectTopology(nodes, edges),
    [nodes, edges]
  );

  const layoutCategory = useMemo<LayoutTopologyCategory>(
    () => classifyLayoutTopology(nodes, edges, isForestTopology),
    [nodes, edges, isForestTopology]
  );

  const isCircularActive =
    layoutMode === "circular" ||
    (layoutMode === "auto" && detectedTopology === "circular-list");

  const syncBadgePositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const overlays: BadgeOverlayItem[] = [];
    cy.nodes().forEach((cyNode) => {
      if (cyNode.data("isDeleting")) return;
      const id = cyNode.id();
      const pos = cyNode.renderedPosition();
      const modelPos = cyNode.position();
      const retainedEntry = retainedNodesRef.current.get(id);
      if (
        retainedEntry &&
        Number.isFinite(modelPos.x) &&
        Number.isFinite(modelPos.y)
      ) {
        retainedEntry.lastPosition = { x: modelPos.x, y: modelPos.y };
      }

      const bb = cyNode.renderedBoundingBox({ includeLabels: false });
      const ptrs = (cyNode.data("pointers") as string[]) || [];
      const isFreed = Boolean(cyNode.data("isFreed"));
      const isDangling = Boolean(cyNode.data("isDangling"));

      if (ptrs.length > 0 || isFreed) {
        overlays.push({
          nodeId: id,
          x: pos.x,
          y: bb.y1 - 10,
          pointers: ptrs,
          isFreed,
          isDangling,
        });
      }
    });

    setBadgeOverlays(overlays);
  }, []);

  const clampCameraFit = useCallback(
    (cy: Core) => {
      resolveLiveCanvasOverlaps(cy, isCircularActive);
      cy.fit(undefined, 50);
      if (cy.zoom() > 1.15) {
        cy.zoom(1.15);
        cy.center();
      } else if (cy.zoom() < 0.35) {
        cy.zoom(0.35);
        cy.center();
      }
      syncBadgePositions();
    },
    [isCircularActive, syncBadgePositions]
  );

  const computeInitialPositionsForTopology = useCallback((): Record<
    string,
    { x: number; y: number }
  > => {
    // Handle explicit user layoutMode overrides first
    if (layoutMode === "circular") {
      return computeCircularListPositions(nodes, edges);
    }

    if (layoutMode === "hierarchical") {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "TB",
        align: "UL",
        nodeSep: 90,
        rankSep: 110,
        edgeSep: 45,
      });
    }

    if (layoutMode === "organic") {
      return effectiveMode === "logical"
        ? computeLayeredLogicalGraphPositions(nodes, edges, 115, 115)
        : computeGeneralMeshSeedPositions(nodes, edges);
    }

    // Default `'auto'` mode (100% unchanged automatic pipeline)
    if (effectiveMode === "logical") {
      return computeLayeredLogicalGraphPositions(nodes, edges, 115, 115);
    }

    if (layoutCategory === "HIERARCHICAL" || isForestTopology) {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "TB",
        align: "UL",
        nodeSep: 90,
        rankSep: 110,
        edgeSep: 45,
      });
    }

    if (detectedTopology === "circular-list") {
      return computeCircularListPositions(nodes, edges);
    }

    return computeGeneralMeshSeedPositions(nodes, edges);
  }, [
    layoutMode,
    layoutCategory,
    detectedTopology,
    effectiveMode,
    isForestTopology,
    nodes,
    edges,
  ]);

  const runActiveLayout = useCallback(
    (
      animate: boolean = false,
      clearDraggedCache: boolean = false,
      overrideMode?: LayoutMode
    ) => {
      const cy = cyRef.current;
      if (!cy || cy.nodes().length === 0) return;

      const activeLayoutSelection = overrideMode ?? layoutMode;

      if (clearDraggedCache) {
        userDraggedPositionsRef.current = {};
        retainedNodesRef.current.forEach((entry) => {
          entry.lastPosition = undefined;
        });
      }

      // ======================================================================
      // Explicit User Override 1: 'hierarchical' (Forces Dagre Top-to-Bottom)
      // ======================================================================
      if (activeLayoutSelection === "hierarchical") {
        const tbConfig: DagreLayoutConfig = {
          name: "dagre",
          rankDir: "TB",
          align: "UL",
          nodeSep: 90,
          rankSep: 110,
          edgeSep: 45,
          ranker: "network-simplex",
          animate,
          animationDuration: animate ? 220 : 0,
          fit: true,
          padding: 50,
        };
        const layout = cy.layout(tbConfig as unknown as LayoutOptions);
        layout.on("layoutstop", () => clampCameraFit(cy));
        layout.run();
        return;
      }

      // ======================================================================
      // Explicit User Override 2: 'organic' (Forces Cose with Strong Anti-Overlap)
      // ======================================================================
      if (activeLayoutSelection === "organic") {
        const seeded = computeInitialPositionsForTopology();
        cy.batch(() => {
          cy.nodes().forEach((n) => {
            const id = n.id();
            const p =
              userDraggedPositionsRef.current[id] ||
              (!clearDraggedCache
                ? retainedNodesRef.current.get(id)?.lastPosition
                : undefined) ||
              seeded[id];
            if (p) n.position(p);
          });
        });

        const organicCoseLayout = cy.layout({
          name: "cose",
          animate: false,
          nodeRepulsion: () => 1200000,
          idealEdgeLength: () => 140,
          edgeElasticity: () => 0.45,
          gravity: 0.2,
          componentSpacing: 110,
          numIter: 1000,
          initialTemp: 200,
          coolingFactor: 0.95,
          minTemp: 1.0,
          randomize: false,
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          padding: 50,
        } as unknown as LayoutOptions);

        organicCoseLayout.on("layoutstop", () => clampCameraFit(cy));
        organicCoseLayout.run();
        return;
      }

      // ======================================================================
      // Explicit User Override 3: 'circular' (Forces Circle Perimeter Ring)
      // ======================================================================
      if (activeLayoutSelection === "circular") {
        const orderedCycleIds = computeOrderedCycleIds(nodes, edges);
        const forcedCircleLayout = cy.layout({
          name: "circle",
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          spacingFactor: 1.5,
          padding: 50,
          startAngle: -Math.PI / 2,
          clockwise: true,
          sort: (a: NodeSingular, b: NodeSingular) => {
            const idxA = orderedCycleIds.indexOf(a.id());
            const idxB = orderedCycleIds.indexOf(b.id());
            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            return 0;
          },
          animate,
          animationDuration: animate ? 220 : 0,
          fit: true,
        } as unknown as LayoutOptions);

        forcedCircleLayout.on("layoutstop", () => clampCameraFit(cy));
        forcedCircleLayout.run();
        return;
      }

      // ======================================================================
      // Default Mode: 'auto' (100% Unchanged Built-In Adaptive Pipeline)
      // ======================================================================
      if (
        effectiveMode === "logical" ||
        layoutCategory === "HIERARCHICAL" ||
        isForestTopology
      ) {
        const tbConfig: DagreLayoutConfig = {
          name: "dagre",
          rankDir: "TB",
          align: "UL",
          nodeSep: effectiveMode === "logical" ? 115 : 90,
          rankSep: effectiveMode === "logical" ? 115 : 110,
          edgeSep: 45,
          ranker: "network-simplex",
          animate,
          animationDuration: animate ? 220 : 0,
          fit: true,
          padding: 55,
        };
        const layout = cy.layout(tbConfig as unknown as LayoutOptions);
        layout.on("layoutstop", () => clampCameraFit(cy));
        layout.run();
        return;
      }

      if (
        effectiveMode === "physical" &&
        detectedTopology === "circular-list"
      ) {
        const orderedCycleIds = computeOrderedCycleIds(nodes, edges);
        const circularLayout = cy.layout({
          name: "circle",
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          spacingFactor: 1.8,
          padding: 80,
          startAngle: -Math.PI / 2,
          clockwise: true,
          sort: (a: NodeSingular, b: NodeSingular) => {
            const idxA = orderedCycleIds.indexOf(a.id());
            const idxB = orderedCycleIds.indexOf(b.id());
            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            return 0;
          },
          animate,
          animationDuration: animate ? 220 : 0,
          fit: true,
        } as unknown as LayoutOptions);
        circularLayout.on("layoutstop", () => clampCameraFit(cy));
        circularLayout.run();
        return;
      }

      const seeded = computeInitialPositionsForTopology();
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const id = n.id();
          const p =
            userDraggedPositionsRef.current[id] ||
            (!clearDraggedCache
              ? retainedNodesRef.current.get(id)?.lastPosition
              : undefined) ||
            seeded[id];
          if (p) n.position(p);
        });
      });

      const coseLayout = cy.layout({
        name: "cose",
        animate: false,
        nodeRepulsion: () => 900000,
        idealEdgeLength: () => 180,
        edgeElasticity: () => 0.45,
        gravity: 0.2,
        componentSpacing: 90,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0,
        randomize: false,
        avoidOverlap: true,
        padding: 60,
      } as unknown as LayoutOptions);

      coseLayout.on("layoutstop", () => clampCameraFit(cy));
      coseLayout.run();
    },
    [
      layoutMode,
      layoutCategory,
      effectiveMode,
      isForestTopology,
      detectedTopology,
      nodes,
      edges,
      computeInitialPositionsForTopology,
      clampCameraFit,
    ]
  );

  const topologyKey = useMemo(() => {
    if (nodes.length === 0) return "";
    const nKeys = nodes
      .map((n) => `${n.id}:${extractDiscreteFieldRows(n).length}`)
      .sort()
      .join(",");
    const eKeys = edges
      .filter((e) =>
        isValidGraphEdge(e, undefined, effectiveMode === "logical")
      )
      .map((e) => {
        const baseLbl = resolveEdgeFieldLabel(e);
        return `${e.source}->${e.target}:${baseLbl}`;
      })
      .sort()
      .join(",");
    return `${effectiveMode}|${layoutMode}|${layoutCategory}|${detectedTopology}|${nKeys}|${eKeys}`;
  }, [
    nodes,
    edges,
    effectiveMode,
    layoutMode,
    layoutCategory,
    detectedTopology,
  ]);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: [
        {
          selector: "node",
          style: {
            shape: "round-rectangle",
            width: HEAP_CARD_WIDTH,
            height: HEAP_CARD_MIN_HEIGHT,
            padding: "8px",
            "background-color": "#0f172a",
            "background-opacity": 0,
            "border-width": 0,
            "background-image": "data(svgUri)",
            "background-fit": "contain",
            "background-clip": "none",
            "z-compound-depth": "top",
            "z-index": 5,
          },
        },
        {
          selector: "node[width][height]",
          style: {
            width: "data(width)",
            height: "data(height)",
          },
        },
        {
          selector: "node[?isLogicalVertex]",
          style: {
            shape: "ellipse",
            width: LOGICAL_VERTEX_SIZE,
            height: LOGICAL_VERTEX_SIZE,
            padding: "0px",
          },
        },
        {
          selector: "node[?isFreed]",
          style: {
            opacity: 0.72,
          },
        },
        {
          selector: "node[?isDeleting]",
          style: {
            opacity: 0.25,
            "overlay-color": "#ef4444",
            "overlay-padding": 8,
            "overlay-opacity": 0.35,
          },
        },
        {
          selector: "node:selected",
          style: {
            "overlay-color": "#f59e0b",
            "overlay-padding": 6,
            "overlay-opacity": 0.22,
          },
        },
        {
          selector: "edge",
          style: {
            width: 2.3,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.35,
            "curve-style": "bezier",
            "control-point-step-size": 45,
            "target-distance-from-node": 3,
            "source-distance-from-node": 3,
            "edge-distances": "node-position",
            label: "",
            "z-compound-depth": "top",
            "z-index": 10,
          } as unknown as cytoscape.Css.Edge,
        },
        {
          selector: 'edge[label != ""]',
          style: {
            label: "data(label)",
            "edge-text-rotation": "autorotate",
            "text-margin-x": "data(textOffsetX)",
            "text-margin-y": "data(textOffsetY)",
            "font-family": "monospace",
            "font-size": 10,
            "font-weight": "bold",
            color: "#f8fafc",
            "text-background-color": "#0f172a",
            "text-background-opacity": 1,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
            "text-border-width": 1,
            "text-border-color": "#334155",
            "text-border-opacity": 1,
          } as unknown as cytoscape.Css.Edge,
        },
        {
          selector: 'edge[?isLogicalEdge][label != ""]',
          style: {
            color: "#fde047",
          },
        },
        {
          selector: "edge[?isActiveEdge]",
          style: {
            width: 3.6,
            "line-color": "#f59e0b",
            "target-arrow-color": "#f59e0b",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.35,
            "curve-style": "bezier",
            "control-point-step-size": 45,
            "target-distance-from-node": 3,
            "source-distance-from-node": 3,
            "z-compound-depth": "top",
            "z-index": 99,
          } as unknown as cytoscape.Css.Edge,
        },
        {
          selector: "edge[?hasActiveMetricBadge]",
          style: {
            color: "#fef3c7",
            "text-background-color": "#b45309",
            "text-background-opacity": 1,
            "text-background-padding": "4px",
            "text-border-color": "#f59e0b",
            "text-border-width": 1.5,
            "text-border-opacity": 1,
          },
        },
        {
          selector: "edge[?isDeleting]",
          style: {
            width: 3.2,
            "line-color": "#ef4444",
            "target-arrow-color": "#ef4444",
            "target-arrow-shape": "triangle",
            "line-style": "dashed",
            opacity: 0.35,
          },
        },
      ],
      minZoom: 0.35,
      maxZoom: 2.0,
    });

    cy.on("pan zoom position drag free layoutstop", () => {
      syncBadgePositions();
    });

    cy.on("dragfree", "node", (evt) => {
      const n = evt.target;
      const pos = { ...n.position() };
      userDraggedPositionsRef.current[n.id()] = pos;
      const retained = retainedNodesRef.current.get(n.id());
      if (retained) {
        retained.lastPosition = pos;
      }
      syncBadgePositions();
    });

    cy.on("tap", "node", (evt) => {
      const nodeData = evt.target.data("rawNode") as
        | ExtendedGraphNode
        | undefined;
      if (nodeData) {
        setSelectedNode(nodeData);
      }
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        setSelectedNode(null);
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [syncBadgePositions]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    if (isConnecting) {
      cy.elements().remove();
      prevTopologyKeyRef.current = "";
      userDraggedPositionsRef.current = {};
      setBadgeOverlays([]);
      setSelectedNode(null);
      return;
    }

    const modeChanged = prevModeRef.current !== effectiveMode;
    prevModeRef.current = effectiveMode;

    const layoutPresetChanged = prevLayoutModeRef.current !== layoutMode;
    prevLayoutModeRef.current = layoutMode;

    if (modeChanged) {
      cy.elements().remove();
      prevTopologyKeyRef.current = "";
      userDraggedPositionsRef.current = {};
    }

    if (layoutPresetChanged) {
      userDraggedPositionsRef.current = {};
      retainedNodesRef.current.forEach((entry) => {
        entry.lastPosition = undefined;
      });
    }

    if (nodes.length === 0) {
      cy.elements().remove();
      prevTopologyKeyRef.current = "";
      setBadgeOverlays([]);
      setSelectedNode(null);
      return;
    }

    const validNodeIds = new Set<string>(nodes.map((n) => n.id));
    const isNewTopology = topologyKey !== prevTopologyKeyRef.current;
    const hadPreviousNodes = cy.nodes().length > 0 && !modeChanged;

    const deterministicPositions = computeInitialPositionsForTopology();

    const rawCandidatePositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, idx) => {
      const existingCyNode = cy.getElementById(n.id);
      const existingPos =
        existingCyNode.length > 0 ? existingCyNode.position() : undefined;
      const cachedPos = retainedNodesRef.current.get(n.id)?.lastPosition;

      rawCandidatePositions[n.id] =
        userDraggedPositionsRef.current[n.id] ||
        (!isNewTopology &&
        existingPos &&
        Number.isFinite(existingPos.x) &&
        Number.isFinite(existingPos.y)
          ? existingPos
          : undefined) ||
        (!isNewTopology ? cachedPos : undefined) ||
        deterministicPositions[n.id] || {
          x: 160 + (idx % 4) * 300,
          y: 160 + Math.floor(idx / 4) * 185,
        };
    });

    const finalPositions = isCircularActive
      ? rawCandidatePositions
      : deoverlapNodePositions(rawCandidatePositions, nodes, 36);

    const desiredEdgeMap = new Map<
      string,
      {
        id: string;
        source: string;
        target: string;
        label: string;
        fieldOrderIdx: number;
        textOffsetX: number;
        textOffsetY: number;
        directed: boolean;
        isLogicalEdge: boolean;
        isActiveEdge: boolean;
        hasActiveMetricBadge: boolean;
        isDeleting: boolean;
      }
    >();

    const pairOccurrenceCounter = new Map<string, number>();

    edges.forEach((e, edgeIdx) => {
      const disallowSelfLoop = effectiveMode === "logical";
      if (isValidGraphEdge(e, validNodeIds, disallowSelfLoop)) {
        const resolvedLabel = resolveEdgeFieldLabel(e);
        const baseKey = `${e.source}->${e.target}:${resolvedLabel}`;
        const occ = pairOccurrenceCounter.get(baseKey) ?? 0;
        pairOccurrenceCounter.set(baseKey, occ + 1);
        const edgeId = `edge-${baseKey}-${occ}`;

        const isAct = Boolean(e.is_active_edge);
        const hasMetric = Boolean(e.has_active_metric);
        const { textOffsetX, textOffsetY } = computeEdgeLabelOffsets(
          e.source,
          e.target,
          edgeIdx
        );

        desiredEdgeMap.set(edgeId, {
          id: edgeId,
          source: e.source,
          target: e.target,
          label: resolvedLabel,
          fieldOrderIdx: e.field_order_idx ?? 0,
          textOffsetX,
          textOffsetY,
          directed: e.directed !== false,
          isLogicalEdge: effectiveMode === "logical",
          isActiveEdge: isAct,
          hasActiveMetricBadge: hasMetric,
          isDeleting: false,
        });
      }
    });

    cy.batch(() => {
      cy.nodes().forEach((existingNode) => {
        if (!validNodeIds.has(existingNode.id())) {
          if (!existingNode.data("isDeleting")) {
            existingNode.data("isDeleting", true);
            window.setTimeout(() => {
              if (existingNode.inside()) {
                existingNode.remove();
                syncBadgePositions();
              }
            }, 220);
          }
        }
      });

      cy.edges().forEach((existingEdge) => {
        if (!desiredEdgeMap.has(existingEdge.id())) {
          existingEdge.remove();
        }
      });

      nodes.forEach((n, idx) => {
        const isFreed = Boolean(n.is_freed) || n.status === "freed";
        const isDangling = Boolean(n.is_dangling);
        const ptrs = Array.isArray(n.pointers) ? n.pointers : [];
        const isLogicalVertex = n.type === "LogicalVertex";

        let svgDataUri = "";
        let finalWidth = HEAP_CARD_WIDTH;
        let finalHeight = HEAP_CARD_MIN_HEIGHT;

        if (isLogicalVertex) {
          const vNum = n.fields?.vertex ?? idx;
          const metricEntries = Object.entries(n.fields || {}).filter(
            ([k]) => k !== "vertex"
          );
          const metricStr =
            metricEntries.length > 0
              ? `${metricEntries[0][0]}=${String(metricEntries[0][1])}`
              : null;
          const isSettled =
            metricEntries.length > 0 && String(metricEntries[0][1]) !== "∞";
          const card = buildSvgVertexCard(
            vNum,
            metricStr,
            ptrs.length > 0 || Boolean(n.is_active),
            isSettled
          );
          svgDataUri = card.svgDataUri;
          finalWidth = card.width;
          finalHeight = card.height;
        } else {
          const card = buildSvgMemoryCard(n);
          svgDataUri = card.svgDataUri;
          finalWidth = card.width;
          finalHeight = card.height;
        }

        const nodeDataPayload = {
          id: n.id,
          width: finalWidth,
          height: finalHeight,
          svgUri: svgDataUri,
          isLogicalVertex,
          isActive: ptrs.length > 0 || Boolean(n.is_active),
          isFreed,
          isDangling,
          isDeleting: false,
          pointers: ptrs,
          rawNode: n,
        };

        const existingEle = cy.getElementById(n.id);
        if (existingEle.length > 0) {
          existingEle.data(nodeDataPayload);
          if (!hadPreviousNodes && finalPositions[n.id]) {
            existingEle.position(finalPositions[n.id]);
          }
        } else {
          cy.add({
            group: "nodes",
            position: finalPositions[n.id],
            data: nodeDataPayload,
          });
        }
      });

      desiredEdgeMap.forEach((edgeSpec) => {
        const existingEdge = cy.getElementById(edgeSpec.id);
        if (existingEdge.length > 0) {
          existingEdge.data(edgeSpec);
        } else {
          cy.add({
            group: "edges",
            data: edgeSpec,
          });
        }
      });
    });

    if (selectedNode) {
      const updated: ExtendedGraphNode | null =
        nodes.find((n) => n.id === selectedNode.id) || null;
      setSelectedNode(updated);
    }

    if (isNewTopology) {
      prevTopologyKeyRef.current = topologyKey;
      runActiveLayout(hadPreviousNodes, false);
    } else {
      resolveLiveCanvasOverlaps(cy, isCircularActive);
      syncBadgePositions();
    }
  }, [
    nodes,
    edges,
    topologyKey,
    effectiveMode,
    layoutMode,
    isForestTopology,
    detectedTopology,
    isCircularActive,
    selectedNode,
    isConnecting,
    computeInitialPositionsForTopology,
    runActiveLayout,
    syncBadgePositions,
  ]);

  const activeLayoutMeta =
    LAYOUT_MODE_OPTIONS.find((opt) => opt.mode === layoutMode) ||
    LAYOUT_MODE_OPTIONS[0];

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden select-none">
      {/* Top Toolbar: Mode Switcher + Split Re-Layout / Preset Selector Button */}
      <div className="absolute top-3 left-3 right-3 z-20 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900/95 backdrop-blur border border-slate-800 pointer-events-auto shadow-lg">
          <button
            type="button"
            disabled={!canProject}
            onClick={() => {
              userDraggedPositionsRef.current = {};
              setViewMode("logical");
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition cursor-pointer ${
              effectiveMode === "logical"
                ? "bg-sky-600 text-white shadow-sm"
                : canProject
                ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                : "text-slate-600 opacity-50 cursor-not-allowed"
            }`}
            title={
              canProject
                ? "View Mathematical Graph G = (V, E) with Dynamic Struct Field Edge Labels"
                : "Logical Graph projection activates automatically when an adjacency or forest structure is detected"
            }
          >
            <Network className="w-3.5 h-3.5" />
            <span>Logical Graph (Topology)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              userDraggedPositionsRef.current = {};
              setViewMode("physical");
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition cursor-pointer ${
              effectiveMode === "physical"
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
            title="View Physical C Heap Structs, Grounded NULL Terminals & [FREED] Blocks"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Physical Memory (Pointers)</span>
          </button>
        </div>

        {/* Sleek Split Button: Main Action (Re-Layout / Center) + Chevron Dropdown Selector */}
        <div
          ref={dropdownRef}
          className="relative flex items-center pointer-events-auto"
        >
          <div className="inline-flex items-stretch rounded-lg bg-slate-900/95 border border-slate-700 shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => {
                setIsLayoutDropdownOpen(false);
                runActiveLayout(true, true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-slate-800 text-slate-200 text-xs font-mono transition cursor-pointer"
              title="Re-run current layout & fit graph to viewport"
            >
              <RotateCcw className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>Re-Layout / Center</span>
              <span
                className={`ml-1 px-1.5 py-0.2 rounded text-[10px] font-bold border ${
                  layoutMode === "auto"
                    ? "bg-slate-800/90 text-slate-300 border-slate-700"
                    : "bg-sky-500/20 text-sky-300 border-sky-500/40"
                }`}
              >
                {activeLayoutMeta.shortTag}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setIsLayoutDropdownOpen((prev) => !prev)}
              className="flex items-center justify-center px-2 hover:bg-slate-800 border-l border-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
              title="Choose optional layout preset override (Default: Auto)"
              aria-expanded={isLayoutDropdownOpen}
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-150 ${
                  isLayoutDropdownOpen ? "rotate-180 text-sky-400" : ""
                }`}
              />
            </button>
          </div>

          {isLayoutDropdownOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-slate-900/95 backdrop-blur border border-slate-700 shadow-2xl py-1.5 z-30">
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 border-b border-slate-800/80 mb-1">
                Layout Algorithm
              </div>
              {LAYOUT_MODE_OPTIONS.map((option) => {
                const isSelected = layoutMode === option.mode;
                return (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => {
                      setIsLayoutDropdownOpen(false);
                      setLayoutMode(option.mode);
                      runActiveLayout(true, true, option.mode);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-xs font-mono transition cursor-pointer ${
                      isSelected
                        ? "bg-sky-600/20 text-sky-300 font-bold"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <span>{option.label}</span>
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Connecting State */}
      {isConnecting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 z-10 text-slate-300 p-8 text-center">
          <Loader2 className="w-10 h-10 text-sky-400 animate-spin mb-3" />
          <p className="text-sm font-mono font-semibold">
            Compiling &amp; Launching Fresh GDB Session...
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Inspecting DWARF struct symbols and pointer topology
          </p>
        </div>
      )}

      {/* Empty State */}
      {!isConnecting && nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 p-8 text-center z-0">
          <Share2 className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
          <p className="text-sm font-medium text-slate-300">
            No Active Struct Pointers or Forest Topology in Scope
          </p>
          <p className="text-xs text-slate-500 max-w-md mt-1">
            Step through code that allocates and links C structs or parent-index
            forests to inspect live memory cards and hierarchies.
          </p>
        </div>
      )}

      {/* Cytoscape Canvas */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Floating Stack Pointer & [FREED] Badges Layer */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
        {badgeOverlays.map((item) => (
          <div
            key={item.nodeId}
            style={{
              transform: `translate(${Math.round(item.x)}px, ${Math.round(
                item.y
              )}px) translate(-50%, -100%)`,
            }}
            className="absolute top-0 left-0 flex flex-col items-center gap-1 transition-transform duration-150 ease-out"
          >
            {item.isFreed && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-950/95 border border-red-500 text-red-200 font-mono text-[10px] font-extrabold tracking-tight shadow-lg whitespace-nowrap">
                <AlertOctagon className="w-3 h-3 text-red-400 shrink-0" />
                <span>
                  {item.isDangling ? "[FREED · DANGLING]" : "[FREED]"}
                </span>
              </div>
            )}

            {item.pointers.length > 0 && (
              <div className="flex items-center gap-1">
                {item.pointers.map((ptrName) => (
                  <div
                    key={ptrName}
                    className={`px-2 py-0.5 rounded-full font-mono text-[11px] font-extrabold border whitespace-nowrap transition-all duration-200 ${getPointerBadgeStyle(
                      ptrName
                    )}`}
                  >
                    {ptrName} ↓
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Selected Node Detailed Inspector Pill */}
      {selectedNode && (
        <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:w-80 z-20 rounded-xl bg-slate-900/95 backdrop-blur border border-sky-500/40 p-4 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2.5">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-sky-400" />
              <span className="font-mono text-xs font-bold text-sky-300">
                {selectedNode.id}
              </span>
              {selectedNode.is_freed || selectedNode.status === "freed" ? (
                <span className="px-1.5 py-0.5 rounded bg-red-500/20 border border-red-500/50 text-red-300 text-[10px] font-mono font-bold">
                  FREED
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-mono">
                  {selectedNode.c_type || selectedNode.type || "struct"}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {selectedNode.pointers && selectedNode.pointers.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 mb-2.5">
              <span className="text-[11px] font-mono text-slate-400">
                Pointers:
              </span>
              {selectedNode.pointers.map((p) => (
                <span
                  key={p}
                  className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-sky-300 font-mono text-[11px]"
                >
                  {p}
                </span>
              ))}
            </div>
          )}

          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {extractDiscreteFieldRows(selectedNode).map(
              ({ key: fieldKey, value: rawStr }) => {
                const isNullVal =
                  rawStr === "NULL" ||
                  rawStr === "0x0" ||
                  rawStr === "0X0" ||
                  rawStr === "(nil)";
                return (
                  <div
                    key={fieldKey}
                    className="flex items-center justify-between px-2.5 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-xs"
                  >
                    <span className="text-sky-400">{fieldKey}</span>
                    <span
                      className={
                        selectedNode.is_freed || selectedNode.status === "freed"
                          ? "text-red-400 line-through"
                          : isNullVal
                          ? "text-slate-500 font-semibold flex items-center gap-1.5"
                          : "text-emerald-400 font-semibold"
                      }
                    >
                      {isNullVal ? (
                        <>
                          <span>⏚ NULL</span>
                          <span className="w-2 h-2 rounded-full bg-slate-800 border border-slate-500 inline-block" />
                        </>
                      ) : (
                        rawStr
                      )}
                    </span>
                  </div>
                );
              }
            )}
          </div>
        </div>
      )}
    </div>
  );
};
