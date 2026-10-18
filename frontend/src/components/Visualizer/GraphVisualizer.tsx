/**
 * frontend/src/components/Visualizer/GraphVisualizer.tsx
 * Topology-Aware DWARF Graph, Tree, Linear-List, Circular-List & Pointer Mesh Visualizer.
 *
 * Key Capabilities:
 * 1. Topological Ring Walk & Perimeter Ordering (`computeOrderedCycleIds`):
 *    - Walks each circular component continuously from a single start node (preferring a
 *      stack-pointer anchor) along consistent outgoing/neighbor links (`nbr !== prev`) to
 *      produce `orderedCycleIds = [id0, id1, id2, ...]`.
 *    - Passes the `orderedCycleIds` comparator directly to Cytoscape's `circle` layout
 *      with `avoidOverlap: true` and `spacingFactor: 1.6` so adjacent nodes in the cycle
 *      sit consecutively along the perimeter with zero diagonal 'X' edge crossings.
 * 2. Native Bundled Bezier Multi-Edge Separation (`curve-style: "bezier"`, `control-point-step-size: 50`).
 * 3. Realistic Physical Card Dimensions (`width: 210`, `height: 95`, `shape: 'round-rectangle'`).
 * 4. Explicit `⏚ NULL` Grounded Pointer Terminals & Atomic Active Edge Metric Binding.
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
}

export interface ExtendedGraphEdge extends GraphEdge {
  field_order_idx?: number;
  base_label?: string;
  is_active_edge?: boolean;
  has_active_metric?: boolean;
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
export type GraphTopologyKind =
  | "linear-list"
  | "circular-list"
  | "tree"
  | "general-graph";

interface BadgeOverlayItem {
  nodeId: string;
  x: number;
  y: number;
  pointers: string[];
  isFreed: boolean;
  isDangling: boolean;
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
const MIN_X_NUDGE_PX = 230;

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
  validNodeIds?: Set<string>
): boolean {
  if (!isValidEdgeEndpoint(edge.source) || !isValidEdgeEndpoint(edge.target)) {
    return false;
  }
  if (validNodeIds) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) {
      return false;
    }
  }
  return true;
}

function getEstimatedNodeDimensions(node: ExtendedGraphNode): {
  width: number;
  height: number;
} {
  if (node.type === "LogicalVertex") {
    return { width: 84, height: 84 };
  }
  const fCount = Object.keys(node.fields || {}).length;
  return {
    width: HEAP_CARD_WIDTH,
    height: Math.max(HEAP_CARD_MIN_HEIGHT, 42 + fCount * 18),
  };
}

/**
 * Prevent Co-located Node Overlap Guard:
 * Checks all node pairs for intersecting bounding boxes (`width + minGap`, `height + minGap`).
 * Whenever two distinct nodes intersect, applies an automatic positional nudge of at least
 * `+230px` along the X-axis (`MIN_X_NUDGE_PX`) so cards never render on top of each other.
 */
function deoverlapNodePositions(
  positions: Record<string, { x: number; y: number }>,
  nodes: ExtendedGraphNode[],
  minGap: number = 36
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const dimById = new Map<string, { width: number; height: number }>();

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

  for (let iter = 0; iter < 10; iter++) {
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
          const targetRightX = pA.x + Math.max(MIN_X_NUDGE_PX, Math.ceil(reqDx));
          if (pB.x < targetRightX) {
            pB.x = Math.round(targetRightX);
          } else {
            pB.x += MIN_X_NUDGE_PX;
          }
        }
      }
    }
    if (!moved) break;
  }

  return result;
}

/**
 * Post-layout live canvas overlap guard for non-circular layouts.
 * Inspects rendered Cytoscape node positions and nudges any intersecting node by `+230px` along X.
 */
function resolveLiveCanvasOverlaps(cy: Core, skipHorizontalSortNudge: boolean = false): void {
  if (skipHorizontalSortNudge) return;
  const cyNodes = cy.nodes().filter((n) => !n.data("isDeleting"));
  if (cyNodes.length <= 1) return;

  const items: Array<{
    node: NodeSingular;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];

  cyNodes.forEach((n) => {
    const pos = n.position();
    const isLogical = Boolean(n.data("isLogicalVertex"));
    const w = Number(n.data("width")) || (isLogical ? 84 : HEAP_CARD_WIDTH);
    const h =
      Number(n.data("height")) || (isLogical ? 84 : HEAP_CARD_MIN_HEIGHT);
    items.push({ node: n, x: pos.x, y: pos.y, w, h });
  });

  let anyModified = false;
  for (let pass = 0; pass < 6; pass++) {
    let movedInPass = false;
    items.sort((a, b) => (Math.abs(a.x - b.x) > 4 ? a.x - b.x : a.y - b.y));

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const reqDx = (a.w + b.w) / 2 + 24;
        const reqDy = (a.h + b.h) / 2 + 20;

        if (Math.abs(b.x - a.x) < reqDx && Math.abs(b.y - a.y) < reqDy) {
          const minTargetX = a.x + Math.max(MIN_X_NUDGE_PX, Math.ceil(reqDx));
          b.x = Math.max(b.x + MIN_X_NUDGE_PX, minTargetX);
          movedInPass = true;
          anyModified = true;
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

/**
 * Purely structural partition separating stack/header container structs from
 * homogeneous heap backbone nodes (Zero Hardcoded Names).
 */
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
      backboneEdges: edges.filter((e) => isValidGraphEdge(e)),
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

/**
 * Automatic Dynamic Topology Classifier (Zero Hardcoding).
 */
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
  ).filter((e) => isValidGraphEdge(e, nodeIds) && e.source !== e.target);

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

/**
 * Topological Walk along the Ring (`computeOrderedCycleIds`):
 * 1. Picks a starting node in the cycle (preferring a node pointed to by a stack/root pointer).
 * 2. Walks the connected cycle step-by-step following a consistent outgoing pointer slot
 *    (`field_order_idx === 0` or primary outgoing edge label) and undirected 2-regular cycle
 *    adjacency (`nbr !== prevId`), collecting node IDs in linear perimeter order:
 *    `orderedCycleIds = [id0, id1, id2, ...]`.
 * 3. Guarantees that consecutive nodes in `orderedCycleIds` are directly connected along
 *    the cycle perimeter, eliminating internal diagonal 'X' crossings.
 */
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
  ).filter((e) => isValidGraphEdge(e, ringIds) && e.source !== e.target);

  // Build outgoing edge list per node sorted by `field_order_idx` so slot 0 (primary link) comes first
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

  // Prefer starting at the first node pointed to by a stack pointer (preserving allocation/input order)
  const anchorCandidates = [...ringNodes].sort((a, b) => {
    const aHasPtr = (a.pointers?.length ?? 0) > 0 ? 0 : 1;
    const bHasPtr = (b.pointers?.length ?? 0) > 0 ? 0 : 1;
    return aHasPtr - bHasPtr;
  });

  const visited = new Set<string>();
  const orderedCycleIds: string[] = [];

  for (const startNode of anchorCandidates) {
    if (visited.has(startNode.id)) continue;

    // Determine the primary link label from `startNode` (slot 0) so we walk consistently
    // in one direction around doubly-linked rings instead of bouncing back along slot 1.
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

      // 1. Prefer outgoing edge matching `primaryLabel` (or `field_order_idx === 0`) that isn't `prevId`
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

      // 2. Otherwise pick the first unvisited outgoing edge that isn't `prevId`
      if (!chosenNext) {
        const anyOut: ExtendedGraphEdge | undefined = outs.find(
          (e) => !visited.has(e.target) && e.target !== prevId
        );
        if (anyOut) {
          chosenNext = anyOut.target;
        }
      }

      // 3. Fallback to any unvisited undirected neighbor in the 2-regular cycle
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

  // Ensure generous chord distance (>= 350px) so 210x95 cards never touch on the perimeter
  const minChord = 350;
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

  // Mode 2: Top-to-Bottom Hierarchical Tree (`rankDir: 'TB'`, Network-Simplex)
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
  const isParentPointerForest = maxIn > 1 && maxOut <= 1;

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

  const roots = treeNodes
    .filter((n) => !childIdSet.has(n.id))
    .map((n) => n.id);
  if (roots.length === 0 && treeNodes.length > 0) {
    roots.push(treeNodes[0].id);
  }

  const UNIT_SLOT = HEAP_CARD_WIDTH + effectiveNodeSep;
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

  roots.forEach((rId) => computeWidth(rId));

  const assignCoords = (uId: string, centerX: number, centerY: number) => {
    positions[uId] = { x: Math.round(centerX), y: Math.round(centerY) };

    const uNode = nodeMap.get(uId);
    const uDim = nodeDims.get(uId) || {
      width: HEAP_CARD_WIDTH,
      height: HEAP_CARD_MIN_HEIGHT,
    };
    const isBinaryNode =
      (uNode?.self_ref_order?.length ?? 0) === 2 && !isParentPointerForest;
    const chList = treeChildren.get(uId) || [];

    if (chList.length === 0) return;

    if (isBinaryNode && chList.length === 1) {
      const onlyChild = chList[0];
      const childDim = nodeDims.get(onlyChild.childId) || {
        width: HEAP_CARD_WIDTH,
        height: HEAP_CARD_MIN_HEIGHT,
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
        width: HEAP_CARD_WIDTH,
        height: HEAP_CARD_MIN_HEIGHT,
      };
      const cCenterX = currentLeft + cW / 2;
      const cCenterY =
        centerY + uDim.height / 2 + effectiveRankSep + childDim.height / 2;
      assignCoords(c.childId, cCenterX, cCenterY);
      currentLeft += cW;
    });
  };

  const isMultiTreeContainer =
    containerNodes.length > 0 && roots.length >= 2;
  const baseRootY =
    containerNodes.length > 0 && !isMultiTreeContainer ? 280 : 130;
  let cursorX = isMultiTreeContainer
    ? 160 + HEAP_CARD_WIDTH + effectiveRankSep + 30
    : 160;

  roots.forEach((rId) => {
    const rW = subtreeWidth.get(rId) || UNIT_SLOT;
    assignCoords(rId, cursorX + rW / 2, baseRootY);
    cursorX += rW + effectiveNodeSep;
  });

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
        if (isValidEdgeEndpoint(srcId) && isValidEdgeEndpoint(tgtId)) {
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
 * Builds an SVG memory card for a physical C struct node matching the explicit
 * `210px` width and `95px` minimum height footprint.
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

  const entries = Object.entries(node.fields || {});
  const fieldCount = entries.length;
  const calculatedWidth = HEAP_CARD_WIDTH;
  const calculatedHeight = Math.max(
    HEAP_CARD_MIN_HEIGHT,
    42 + fieldCount * 18
  );

  const headerHeight = 28;
  const rowHeight = 18;

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
      headerHeight + 20
    }" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#94a3b8">${fallbackText}</text>`;
  } else {
    entries.forEach(([k, v], idx) => {
      const yPos = headerHeight + 17 + idx * rowHeight;
      const keyText = escapeXml(k.length > 13 ? `${k.slice(0, 12)}…` : k);
      const rawValStr = String(v).trim();
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

      const groundPinSvg = isNullPointerField
        ? `<circle cx="${calculatedWidth - 9}" cy="${
            yPos - 3.5
          }" r="2.4" fill="#1e293b" stroke="#64748b" stroke-width="1.2"/>`
        : "";

      rowsSvg += `
        <text x="12" y="${yPos}" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="600" fill="${
          isFreed ? "#f87171" : "#38bdf8"
        }">${keyText}:</text>
        <text x="${valRightX}" y="${yPos}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" ${strikeAttr} fill="${
          isFreed ? "#fca5a5" : valColor
        }">${escapeXml(formattedVal)}</text>
        ${groundPinSvg}
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

function buildSvgVertexCard(
  vertexIndex: number | string,
  metricLabel: string | null,
  isActive: boolean,
  isSettled: boolean
): { svgDataUri: string; width: number; height: number } {
  const size = 76;
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
    size / 2 - 3
  }" fill="${bgFill}" stroke="${borderColor}" stroke-width="3"/>
    <text x="${size / 2}" y="${
    metricLabel ? 33 : 42
  }" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12.5" font-weight="800" fill="#f8fafc">Node ${escapeXml(
    String(vertexIndex)
  )}</text>
    ${
      metricLabel
        ? `<text x="${
            size / 2
          }" y="51" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" fill="#34d399">${escapeXml(
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
  weight: number | string | null;
  metricFieldNames: string[];
  metricValues: number[];
  chainNodeId: string;
  isActiveTraversal: boolean;
  traversalPtrs: string[];
}

/**
 * Atomic Traversal-Pointer Driven Logical Graph & Edge-Metric Projection.
 */
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

  // Case 1: Index-Buffer Forest Topology (e.g. Disjoint Set Union parent[] array)
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
    ).filter((e) => isValidGraphEdge(e));

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
          return {
            ...n,
            type: "LogicalVertex",
            label: `Node ${idxNum}`,
            fields: {
              vertex: idxNum,
              "→": targetVal,
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

  // Case 2: Adjacency-List Graph Projection & Atomic Traversal-Pointer Edge Activation
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
        const scalarNums: Array<[string, number | string]> = [];
        Object.entries(chainNode.fields || {}).forEach(([k, val]) => {
          const sVal = String(val).trim();
          if (
            !isNullAddressToken(sVal) &&
            !sVal.startsWith("0x") &&
            !sVal.startsWith("0X") &&
            !sVal.startsWith("ptr[")
          ) {
            scalarNums.push([k, val]);
          }
        });

        if (scalarNums.length >= 1) {
          const destVal = Number(scalarNums[0][1]);
          const weightVal = scalarNums.length >= 2 ? scalarNums[1][1] : null;
          const metricFieldNames: string[] = scalarNums
            .slice(1)
            .map(([k]) => k);
          const metricValues: number[] = scalarNums
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
            destVal < vertexCount
          ) {
            discoveredEdges.push({
              u: uIdx,
              v: destVal,
              weight: weightVal,
              metricFieldNames,
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
    const { u: actU, v: actV, weight: actWeight, metricValues } =
      activePhysicalEdge;

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
    scalarLocals.forEach((val, varName) => {
      if (
        varName !== chosenUVar &&
        varName !== chosenVVar &&
        !knownVertexVars.has(varName) &&
        metricValues.includes(val)
      ) {
        boundMetricVarName = varName;
      }
    });

    if (!boundMetricVarName) {
      scalarLocals.forEach((_val, varName) => {
        if (
          boundMetricVarName === null &&
          varName !== chosenUVar &&
          varName !== chosenVVar &&
          knownMetricVars.has(varName) &&
          (primaryMetricArray?.active_indices?.[varName] !== undefined ||
            vertexDomainArrays.some(
              (a) => a.active_indices?.[varName] !== undefined
            ))
        ) {
          boundMetricVarName = varName;
        }
      });
    }

    if (boundMetricVarName && actWeight !== null) {
      activeEdgeMetricBinding = {
        u: actU,
        v: actV,
        varName: boundMetricVarName,
        varVal: actWeight,
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

  const sourceEdgesList: Array<{
    u: number;
    v: number;
    weightStr: string;
    isActive: boolean;
  }> = [];

  if (discoveredEdges.length > 0) {
    discoveredEdges.forEach((de) => {
      sourceEdgesList.push({
        u: de.u,
        v: de.v,
        weightStr: de.weight !== null ? String(de.weight) : "",
        isActive: de.isActiveTraversal,
      });
    });
  } else if (backendLogical && Array.isArray(backendLogical.edges)) {
    backendLogical.edges.forEach((be) => {
      if (!isValidGraphEdge(be)) return;
      const uNum = Number(be.source.replace("vertex-", ""));
      const vNum = Number(be.target.replace("vertex-", ""));
      const rawW = (be.label || "").replace(/^w:\s*/, "").trim();
      if (Number.isInteger(uNum) && Number.isInteger(vNum)) {
        sourceEdgesList.push({
          u: uNum,
          v: vNum,
          weightStr: rawW,
          isActive: false,
        });
      }
    });
  }

  const edgeSet = new Set<string>(
    sourceEdgesList.map((e) => `${e.u}->${e.v}:${e.weightStr}`)
  );
  const activeDirectedPairs = new Set<string>(
    sourceEdgesList
      .filter((e) => e.isActive)
      .map((e) => `${e.u}->${e.v}:${e.weightStr}`)
  );

  const emittedPairs = new Set<string>();
  const logicalEdges: ExtendedGraphEdge[] = [];

  for (const e of sourceEdgesList) {
    const reverseKey = `${e.v}->${e.u}:${e.weightStr}`;
    const isUndirected = edgeSet.has(reverseKey);

    let finalU = e.u;
    let finalV = e.v;
    let isEdgeActive = e.isActive;

    if (isUndirected) {
      const canon = `${Math.min(e.u, e.v)}--${Math.max(e.u, e.v)}:${e.weightStr}`;
      if (emittedPairs.has(canon)) continue;
      emittedPairs.add(canon);

      const forwardActive = activeDirectedPairs.has(
        `${e.u}->${e.v}:${e.weightStr}`
      );
      const reverseActive = activeDirectedPairs.has(reverseKey);
      isEdgeActive = forwardActive || reverseActive;

      if (reverseActive && !forwardActive) {
        finalU = e.v;
        finalV = e.u;
      }
    }

    const baseLabel = e.weightStr !== "" ? `w: ${e.weightStr}` : "";
    let displayLabel = baseLabel;
    const hasActiveMetric = isEdgeActive && baseLabel !== "";

    if (
      isEdgeActive &&
      activeEdgeMetricBinding &&
      activeEdgeMetricBinding.u === finalU &&
      activeEdgeMetricBinding.v === finalV
    ) {
      displayLabel =
        baseLabel !== ""
          ? `${baseLabel} (${activeEdgeMetricBinding.varName} = ${activeEdgeMetricBinding.varVal})`
          : `${activeEdgeMetricBinding.varName} = ${activeEdgeMetricBinding.varVal}`;
    }

    logicalEdges.push({
      source: `vertex-${finalU}`,
      target: `vertex-${finalV}`,
      label: displayLabel,
      base_label: baseLabel,
      is_active_edge: isEdgeActive,
      has_active_metric: hasActiveMetric,
    });
  }

  return {
    canProject: true,
    isForestTopology: false,
    logicalGraph: {
      nodes: logicalNodes,
      edges: logicalEdges,
    },
  };
}

function computeLogicalCirclePositions(
  nodes: ExtendedGraphNode[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const N = nodes.length;
  if (N === 0) return positions;

  const centerX = 320;
  const centerY = 240;
  const radius = Math.max(165, Math.min(290, N * 55));

  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / N - Math.PI / 2;
    const x = Math.round(centerX + radius * Math.cos(angle));
    const y = Math.round(centerY + radius * Math.sin(angle));
    positions[node.id] = { x, y };
  });

  return positions;
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
  const cyRef = useRef<Core | null>(null);
  const prevTopologyKeyRef = useRef<string>("");
  const prevModeRef = useRef<ViewMode>("logical");
  const userDraggedPositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  const knownMetricVarsRef = useRef<Set<string>>(new Set<string>());
  const knownVertexVarsRef = useRef<Set<string>>(new Set<string>());

  const [viewMode, setViewMode] = useState<ViewMode>("logical");
  const [selectedNode, setSelectedNode] = useState<ExtendedGraphNode | null>(
    null
  );
  const [badgeOverlays, setBadgeOverlays] = useState<BadgeOverlayItem[]>([]);

  if (isConnecting) {
    knownMetricVarsRef.current.clear();
    knownVertexVarsRef.current.clear();
  }

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

  const nodes: ExtendedGraphNode[] = useMemo(
    () =>
      (activeGraphData?.nodes || []).filter((n) => isValidEdgeEndpoint(n.id)),
    [activeGraphData]
  );

  const edges: ExtendedGraphEdge[] = useMemo(() => {
    const validIds = new Set<string>(nodes.map((n) => n.id));
    return (activeGraphData?.edges || []).filter((e) =>
      isValidGraphEdge(e, validIds)
    );
  }, [activeGraphData, nodes]);

  const detectedTopology = useMemo<GraphTopologyKind>(
    () => detectTopology(nodes, edges),
    [nodes, edges]
  );

  const isCircleMode =
    (effectiveMode === "logical" && !isForestTopology) ||
    detectedTopology === "circular-list";

  const syncBadgePositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const overlays: BadgeOverlayItem[] = [];
    cy.nodes().forEach((cyNode) => {
      if (cyNode.data("isDeleting")) return;
      const id = cyNode.id();
      const pos = cyNode.renderedPosition();
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
      resolveLiveCanvasOverlaps(cy, isCircleMode);
      cy.fit(undefined, 65);
      if (cy.zoom() > 1.15) {
        cy.zoom(1.15);
        cy.center();
      } else if (cy.zoom() < 0.38) {
        cy.zoom(0.38);
        cy.center();
      }
      syncBadgePositions();
    },
    [isCircleMode, syncBadgePositions]
  );

  const computeInitialPositionsForTopology = useCallback((): Record<
    string,
    { x: number; y: number }
  > => {
    if (effectiveMode === "logical" && !isForestTopology) {
      return computeLogicalCirclePositions(nodes);
    }

    if (detectedTopology === "circular-list") {
      return computeCircularListPositions(nodes, edges);
    }

    if (detectedTopology === "linear-list") {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "LR",
        align: "UL",
        nodeSep: 90,
        rankSep: 110,
        edgeSep: 40,
      });
    }

    if (detectedTopology === "tree" || isForestTopology) {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "TB",
        align: "UL",
        nodeSep: 90,
        rankSep: 110,
        edgeSep: 45,
      });
    }

    return computeGeneralMeshSeedPositions(nodes, edges);
  }, [effectiveMode, isForestTopology, detectedTopology, nodes, edges]);

  const runActiveLayout = useCallback(
    (animate: boolean = true, clearDraggedCache: boolean = false) => {
      const cy = cyRef.current;
      if (!cy || cy.nodes().length === 0) return;

      if (clearDraggedCache) {
        userDraggedPositionsRef.current = {};
      }

      if (effectiveMode === "logical" && !isForestTopology) {
        const circleLayout = cy.layout({
          name: "circle",
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          spacingFactor: 1.4,
          padding: 60,
          startAngle: -Math.PI / 2,
          clockwise: true,
          animate,
          animationDuration: animate ? 250 : 0,
          fit: true,
        });
        circleLayout.on("layoutstop", () => clampCameraFit(cy));
        circleLayout.run();
        return;
      }

      if (detectedTopology === "circular-list") {
        const { containerNodes } = partitionContainersAndBackbone(nodes, edges);
        const orderedCycleIds = computeOrderedCycleIds(nodes, edges);

        if (containerNodes.length === 0) {
          const circularLayout = cy.layout({
            name: "circle",
            avoidOverlap: true,
            nodeDimensionsIncludeLabels: true,
            spacingFactor: 1.6,
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
            animationDuration: animate ? 250 : 0,
            fit: true,
          } as unknown as LayoutOptions);
          circularLayout.on("layoutstop", () => clampCameraFit(cy));
          circularLayout.run();
          return;
        }

        const ringPositions = computeCircularListPositions(nodes, edges);
        const presetLayout = cy.layout({
          name: "preset",
          positions: (ele: NodeSingular) =>
            ringPositions[ele.id()] || ele.position(),
          animate,
          animationDuration: animate ? 250 : 0,
          fit: true,
          padding: 80,
        } as unknown as LayoutOptions);
        presetLayout.on("layoutstop", () => clampCameraFit(cy));
        presetLayout.run();
        return;
      }

      if (detectedTopology === "linear-list") {
        const lrConfig: DagreLayoutConfig = {
          name: "dagre",
          rankDir: "LR",
          align: "UL",
          nodeSep: 90,
          rankSep: 110,
          edgeSep: 40,
          animate,
          animationDuration: animate ? 250 : 0,
          fit: true,
          padding: 60,
        };
        const layout = cy.layout(lrConfig as unknown as LayoutOptions);
        layout.on("layoutstop", () => clampCameraFit(cy));
        layout.run();
        return;
      }

      if (detectedTopology === "tree" || isForestTopology) {
        const tbConfig: DagreLayoutConfig = {
          name: "dagre",
          rankDir: "TB",
          align: "UL",
          nodeSep: 90,
          rankSep: 110,
          edgeSep: 45,
          ranker: "network-simplex",
          animate,
          animationDuration: animate ? 250 : 0,
          fit: true,
          padding: 60,
        };
        const layout = cy.layout(tbConfig as unknown as LayoutOptions);
        layout.on("layoutstop", () => clampCameraFit(cy));
        layout.run();
        return;
      }

      const seeded = computeInitialPositionsForTopology();
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const p = seeded[n.id()];
          if (p) n.position(p);
        });
      });

      const coseLayout = cy.layout({
        name: "cose",
        avoidOverlap: true,
        spacingFactor: 1.4,
        animate,
        animationDuration: animate ? 250 : 0,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 520000,
        idealEdgeLength: () => 250,
        edgeElasticity: () => 0.25,
        componentSpacing: 130,
        nodeOverlap: 90,
        gravity: 0.15,
        randomize: false,
      } as unknown as LayoutOptions);
      coseLayout.on("layoutstop", () => clampCameraFit(cy));
      coseLayout.run();
    },
    [
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
      .map((n) => `${n.id}:${Object.keys(n.fields || {}).length}`)
      .sort()
      .join(",");
    const eKeys = edges
      .filter((e) => isValidGraphEdge(e))
      .map((e) => {
        const baseLbl = e.base_label ?? e.label ?? "";
        if (effectiveMode === "logical" && !isForestTopology) {
          const uMin = e.source < e.target ? e.source : e.target;
          const vMax = e.source < e.target ? e.target : e.source;
          return `${uMin}--${vMax}:${baseLbl}`;
        }
        return `${e.source}->${e.target}:${baseLbl}`;
      })
      .sort()
      .join(",");
    return `${effectiveMode}|${detectedTopology}|${nKeys}|${eKeys}`;
  }, [nodes, edges, effectiveMode, isForestTopology, detectedTopology]);

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
            "z-index": 10,
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
            width: "data(width)",
            height: "data(height)",
            padding: "4px",
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
            width: 2.2,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.15,
            "curve-style": "bezier",
            "control-point-step-size": 50,
            "edge-distances": "node-position",
            label: "data(label)",
            "text-rotation": "autorotate",
            "text-margin-y": -9,
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
            "z-compound-depth": "bottom",
            "z-index": 1,
          },
        },
        {
          selector: "edge[?isUndirectedLogical]",
          style: {
            width: 2.6,
            "line-color": "#64748b",
            "target-arrow-shape": "none",
            color: "#fde047",
          },
        },
        {
          selector: "edge[?isActiveEdge]",
          style: {
            width: 3.5,
            "line-color": "#f59e0b",
            "target-arrow-color": "#f59e0b",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.25,
            "z-compound-depth": "top",
            "z-index": 99,
          },
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
            "line-style": "dashed",
            opacity: 0.35,
          },
        },
      ],
      minZoom: 0.15,
      maxZoom: 2.0,
    });

    cy.on("pan zoom position drag free layoutstop", () => {
      syncBadgePositions();
    });

    cy.on("dragfree", "node", (evt) => {
      const n = evt.target;
      userDraggedPositionsRef.current[n.id()] = { ...n.position() };
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

    if (isConnecting || nodes.length === 0) {
      cy.elements().remove();
      prevTopologyKeyRef.current = "";
      if (isConnecting) {
        userDraggedPositionsRef.current = {};
      }
      setBadgeOverlays([]);
      setSelectedNode(null);
      return;
    }

    const modeChanged = prevModeRef.current !== effectiveMode;
    prevModeRef.current = effectiveMode;

    const validNodeIds = new Set<string>(nodes.map((n) => n.id));
    const isNewTopology = topologyKey !== prevTopologyKeyRef.current;
    const hadPreviousNodes = cy.nodes().length > 0 && !modeChanged;

    if (isNewTopology) {
      userDraggedPositionsRef.current = {};
    }

    const deterministicPositions = computeInitialPositionsForTopology();

    const rawCandidatePositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, idx) => {
      const existingCyNode = cy.getElementById(n.id);
      const existingPos =
        existingCyNode.length > 0 && !isNewTopology
          ? existingCyNode.position()
          : undefined;

      rawCandidatePositions[n.id] =
        userDraggedPositionsRef.current[n.id] ||
        existingPos ||
        deterministicPositions[n.id] || {
          x: 160 + (idx % 4) * 300,
          y: 160 + Math.floor(idx / 4) * 185,
        };
    });

    // Do not apply left-to-right X-nudging when in circle mode (`circular-list` or `logical` circle),
    // because circular layouts already space nodes radially around the perimeter.
    const finalPositions = isCircleMode
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
        isUndirectedLogical: boolean;
        isActiveEdge: boolean;
        hasActiveMetricBadge: boolean;
        isDeleting: boolean;
      }
    >();

    const activeCanonicalPairs = new Set<string>();
    const pairOccurrenceCounter = new Map<string, number>();

    edges.forEach((e) => {
      if (isValidGraphEdge(e, validNodeIds)) {
        const uMin = e.source < e.target ? e.source : e.target;
        const vMax = e.source < e.target ? e.target : e.source;
        const baseLbl = e.base_label ?? e.label ?? "";
        activeCanonicalPairs.add(`${uMin}--${vMax}:${baseLbl}`);

        const baseKey = `${e.source}->${e.target}:${baseLbl}`;
        const occ = pairOccurrenceCounter.get(baseKey) ?? 0;
        pairOccurrenceCounter.set(baseKey, occ + 1);
        const edgeId = `edge-${baseKey}-${occ}`;

        const isAct = Boolean(e.is_active_edge);
        const hasMetric = Boolean(e.has_active_metric);

        desiredEdgeMap.set(edgeId, {
          id: edgeId,
          source: e.source,
          target: e.target,
          label: e.label ?? "",
          fieldOrderIdx: e.field_order_idx ?? 0,
          isUndirectedLogical:
            effectiveMode === "logical" && !isForestTopology && !isAct,
          isActiveEdge: isAct,
          hasActiveMetricBadge: hasMetric,
          isDeleting: false,
        });
      }
    });

    cy.batch(() => {
      cy.nodes().forEach((existingNode) => {
        if (!validNodeIds.has(existingNode.id())) {
          if (effectiveMode === "logical" && !modeChanged) {
            if (!existingNode.data("isDeleting")) {
              existingNode.data("isDeleting", true);
              window.setTimeout(() => {
                if (existingNode.inside()) {
                  existingNode.remove();
                  syncBadgePositions();
                }
              }, 280);
            }
          } else {
            existingNode.remove();
          }
        }
      });

      cy.edges().forEach((existingEdge) => {
        if (!desiredEdgeMap.has(existingEdge.id())) {
          const srcId = existingEdge.source().id();
          const tgtId = existingEdge.target().id();
          const srcExists = validNodeIds.has(srcId);
          const tgtExists = validNodeIds.has(tgtId);

          const uMin = srcId < tgtId ? srcId : tgtId;
          const vMax = srcId < tgtId ? tgtId : srcId;
          const rawLbl = String(existingEdge.data("label") ?? "").replace(
            /\s*\([^\)]+\)$/,
            ""
          );
          const stillExistsReversed = activeCanonicalPairs.has(
            `${uMin}--${vMax}:${rawLbl}`
          );

          if (
            effectiveMode === "logical" &&
            !modeChanged &&
            !isForestTopology &&
            srcExists &&
            tgtExists &&
            !stillExistsReversed
          ) {
            if (!existingEdge.data("isDeleting")) {
              existingEdge.data("isDeleting", true);
              window.setTimeout(() => {
                if (existingEdge.inside()) {
                  existingEdge.remove();
                }
              }, 280);
            }
          } else {
            existingEdge.remove();
          }
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
          existingEle.position(finalPositions[n.id]);
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
      resolveLiveCanvasOverlaps(cy, isCircleMode);
      syncBadgePositions();
    }
  }, [
    nodes,
    edges,
    topologyKey,
    effectiveMode,
    isForestTopology,
    isCircleMode,
    selectedNode,
    isConnecting,
    computeInitialPositionsForTopology,
    runActiveLayout,
    syncBadgePositions,
  ]);

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden select-none">
      {/* Top Toolbar: Mode Switcher + Re-Layout Button */}
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
                ? "View Mathematical Graph G = (V, E) with Atomic Active Edge & Metric Binding"
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

        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={() => runActiveLayout(true, true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/95 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono shadow-lg transition cursor-pointer"
            title="Invalidate Cached Positions & Re-Layout All Nodes"
          >
            <RotateCcw className="w-3.5 h-3.5 text-sky-400" />
            <span>Re-Layout / Center</span>
          </button>
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
            {Object.entries(selectedNode.fields || {}).map(
              ([fieldKey, fieldVal]) => {
                const rawStr = String(fieldVal).trim();
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
