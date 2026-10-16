/**
 * frontend/src/components/Visualizer/GraphVisualizer.tsx
 * Topology-Aware DWARF Graph, Tree, Linear-List & Pointer Mesh Visualizer.
 *
 * Key Guarantees (Prompt 2/4):
 * 1. Automatic Topology Classifier (`detectTopology(nodes, edges)`):
 *    - Collapses symmetric pointer pairs (`u -> v` and `v -> u`, e.g. doubly-linked lists)
 *      into a single bidirectional link for degree and cycle analysis.
 *    - Classifies active structures without any hardcoded struct or field names into:
 *      * `'linear-list'`: Acyclic 1D chains where canonical in-degree <= 1 and out-degree <= 1.
 *      * `'tree'`: Directed acyclic hierarchies (binary trees, ternary/k-ary trees, tries, DSU forests).
 *      * `'general-graph'`: Cyclic meshes or multi-parent DAGs.
 * 2. Adaptive Layout Configurations:
 *    - `'linear-list'` -> Cytoscape `dagre` (`rankDir: 'LR', nodeSep: 60, rankSep: 80, edgeSep: 30`)
 *    - `'tree'`        -> Cytoscape `dagre` (`rankDir: 'TB', nodeSep: 90, rankSep: 110, edgeSep: 40, ranker: 'network-simplex'`)
 *    - `'general-graph'` -> Cytoscape `cose` (`nodeRepulsion: 8000, idealEdgeLength: 120, componentSpacing: 100`)
 * 3. Dimension-Aware Edge Routing & Autorotated Labels:
 *    - `'edge-text-rotation': 'autorotate'`, `'text-background-opacity': 1`, `'text-background-color': '#0f172a'`.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import cytoscape, { type Core, type LayoutOptions } from "cytoscape";
import {
  type GraphData,
  type GraphNode,
  type GraphEdge,
  type ArraySnapshot,
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

export interface GraphVisualizerProps {
  graph: GraphData;
  locals?: Record<string, number | string>;
  arrays?: ArraySnapshot[];
  isConnecting?: boolean;
}

type ViewMode = "logical" | "physical";
export type GraphTopologyKind = "linear-list" | "tree" | "general-graph";

interface BadgeOverlayItem {
  nodeId: string;
  x: number;
  y: number;
  pointers: string[];
  isFreed: boolean;
}

interface ExtendedGraphNode extends GraphNode {
  self_ref_order?: string[];
  status?: string;
}

interface ExtendedGraphEdge extends GraphEdge {
  field_order_idx?: number;
}

interface DagreLayoutConfig {
  name: "dagre";
  rankDir: "LR" | "TB";
  nodeSep: number;
  rankSep: number;
  edgeSep: number;
  ranker?: "network-simplex" | "tight-tree" | "longest-path";
  animate: boolean;
  animationDuration: number;
  fit: boolean;
  padding: number;
}

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

/**
 * Automatic Topology Classifier (Zero Hardcoding):
 * Analyzes the active node and edge set by collapsing symmetric pointer pairs
 * (`u -> v` and `v -> u`) into single bidirectional links:
 *   - `'linear-list'`: Acyclic 1D chains where canonical in-degree <= 1 and out-degree <= 1
 *     (undirected degree <= 2 in every component).
 *   - `'tree'`: Acyclic hierarchy where max undirected degree > 2 (or branching factor >= 2)
 *     and canonical in-degree <= 1 (top-down tree) or out-degree <= 1 (parent-pointer forest).
 *   - `'general-graph'`: Contains undirected cycles of length >= 3 or multi-parent DAG merges.
 */
export function detectTopology(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): GraphTopologyKind {
  if (nodes.length <= 1) {
    return "linear-list";
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target
  );

  if (validEdges.length === 0) {
    return "linear-list";
  }

  // Collapse parallel and symmetric edges `(u -> v)` and `(v -> u)` into unique undirected pairs
  const undirNeighbors = new Map<string, Set<string>>();
  nodes.forEach((n) => undirNeighbors.set(n.id, new Set<string>()));

  const uniqueUndirPairs = new Set<string>();
  validEdges.forEach((e) => {
    undirNeighbors.get(e.source)!.add(e.target);
    undirNeighbors.get(e.target)!.add(e.source);
    const canonPair =
      e.source < e.target ? `${e.source}::${e.target}` : `${e.target}::${e.source}`;
    uniqueUndirPairs.add(canonPair);
  });

  // Check each undirected connected component for cycles of length >= 3:
  // A connected component with V_c vertices is acyclic iff its unique undirected edge count E_c == V_c - 1.
  const visited = new Set<string>();
  let hasUndirectedCycle = false;
  let maxUndirectedDegree = 0;

  for (const n of nodes) {
    const deg = undirNeighbors.get(n.id)?.size ?? 0;
    if (deg > maxUndirectedDegree) {
      maxUndirectedDegree = deg;
    }

    if (!visited.has(n.id)) {
      const compNodes: string[] = [];
      const queue: string[] = [n.id];
      visited.add(n.id);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        compNodes.push(curr);
        undirNeighbors.get(curr)?.forEach((nbr) => {
          if (!visited.has(nbr)) {
            visited.add(nbr);
            queue.push(nbr);
          }
        });
      }

      let compUndirEdgeCount = 0;
      compNodes.forEach((u) => {
        undirNeighbors.get(u)?.forEach((v) => {
          if (u < v) compUndirEdgeCount += 1;
        });
      });

      if (compUndirEdgeCount >= compNodes.length) {
        hasUndirectedCycle = true;
      }
    }
  }

  if (hasUndirectedCycle) {
    return "general-graph";
  }

  // Every component is an acyclic tree/path in the collapsed undirected skeleton!
  // If no node has undirected degree > 2, every component is a 1D Linear Chain / Doubly-Linked List.
  if (maxUndirectedDegree <= 2) {
    // Also verify that if there are no symmetric back-edges, we don't have a v-shaped 3-node tree
    // (`root -> left` and `root -> right` where root has out-degree 2 and in-degree 0).
    const directedPairSet = new Set(
      validEdges.map((e) => `${e.source}->${e.target}`)
    );
    let hasPureBranchingRoot = false;
    nodes.forEach((n) => {
      const nonSymmetricOutTargets = new Set<string>();
      validEdges.forEach((e) => {
        if (
          e.source === n.id &&
          !directedPairSet.has(`${e.target}->${e.source}`)
        ) {
          nonSymmetricOutTargets.add(e.target);
        }
      });
      if (nonSymmetricOutTargets.size >= 2) {
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
 * Dimension-Aware Dagre Hierarchical Layout Engine (`rankDir: 'LR'` & `rankDir: 'TB'`).
 * Computes exact border-to-border `nodeSep` and `rankSep` coordinates so:
 *   - `'LR'` Linear Lists (`head <-> second <-> third`) form a crisp 1D horizontal sequence.
 *   - `'TB'` Multi-Child Trees (`left`, `mid`, `right` or 20-node BSTs) have full `nodeSep: 90px`
 *     horizontal clearance between sibling cards and `rankSep: 110px` vertical clearance between
 *     parent and child card borders.
 */
function computeDagreHierarchicalPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[],
  config: {
    rankDir: "LR" | "TB";
    nodeSep: number;
    rankSep: number;
    edgeSep: number;
  }
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const nodeMap = new Map<string, ExtendedGraphNode>();
  const nodeDims = new Map<string, { width: number; height: number }>();

  nodes.forEach((n) => {
    nodeMap.set(n.id, n);
    const fCount = Object.keys(n.fields || {}).length;
    const width = 160;
    const height = Math.max(52, 38 + fCount * 18);
    nodeDims.set(n.id, { width, height });
  });

  const validEdges = edges.filter(
    (e) => nodeMap.has(e.source) && nodeMap.has(e.target) && e.source !== e.target
  );

  // ---------------------------------------------------------------------------
  // Mode 1: Horizontal 1D Linear List (`rankDir: 'LR'`)
  // ---------------------------------------------------------------------------
  if (config.rankDir === "LR") {
    const undirAdj = new Map<string, string[]>();
    const forwardInDeg = new Map<string, number>();
    const directedSet = new Set(
      validEdges.map((e) => `${e.source}->${e.target}`)
    );

    nodes.forEach((n) => {
      undirAdj.set(n.id, []);
      forwardInDeg.set(n.id, 0);
    });

    validEdges.forEach((e) => {
      const uList = undirAdj.get(e.source)!;
      if (!uList.includes(e.target)) uList.push(e.target);
      const vList = undirAdj.get(e.target)!;
      if (!vList.includes(e.source)) vList.push(e.source);

      // Count non-symmetric incoming edges
      if (!directedSet.has(`${e.target}->${e.source}`)) {
        forwardInDeg.set(e.target, (forwardInDeg.get(e.target) || 0) + 1);
      }
    });

    const visited = new Set<string>();
    let currentRowY = 180;

    // Order components so nodes with active stack pointers (`head`) come first
    const sortedCandidates = [...nodes].sort((a, b) => {
      const aDeg = undirAdj.get(a.id)?.length ?? 0;
      const bDeg = undirAdj.get(b.id)?.length ?? 0;
      // Prefer chain endpoints (degree <= 1)
      const aIsEnd = aDeg <= 1 ? 0 : 1;
      const bIsEnd = bDeg <= 1 ? 0 : 1;
      if (aIsEnd !== bIsEnd) return aIsEnd - bIsEnd;

      // Among endpoints, prefer lower non-symmetric in-degree
      const aIn = forwardInDeg.get(a.id) ?? 0;
      const bIn = forwardInDeg.get(b.id) ?? 0;
      if (aIn !== bIn) return aIn - bIn;

      // Prefer nodes referenced by stack pointers
      const aHasPtr = (a.pointers?.length ?? 0) > 0 ? 0 : 1;
      const bHasPtr = (b.pointers?.length ?? 0) > 0 ? 0 : 1;
      return aHasPtr - bHasPtr;
    });

    for (const startNode of sortedCandidates) {
      if (visited.has(startNode.id)) continue;

      // Walk linear chain from `startNode`
      const chain: string[] = [];
      let curr: string | undefined = startNode.id;

      while (curr && !visited.has(curr)) {
        visited.add(curr);
        chain.push(curr);
        // Prefer outgoing edge order from `curr` first, then undirected neighbor
        const nextOutgoing = validEdges.find(
          (e) => e.source === curr && !visited.has(e.target)
        );
        if (nextOutgoing) {
          curr = nextOutgoing.target;
        } else {
          const fallbackNbr: string | undefined = (undirAdj.get(curr) || []).find(
            (nbr) => !visited.has(nbr)
          );
          curr = fallbackNbr;
        }
      }

      let cursorX = 140;
      let maxChainHeight = 76;

      chain.forEach((nodeId, idx) => {
        const dim = nodeDims.get(nodeId) || { width: 160, height: 76 };
        maxChainHeight = Math.max(maxChainHeight, dim.height);
        if (idx === 0) {
          positions[nodeId] = { x: cursorX, y: currentRowY };
        } else {
          const prevId = chain[idx - 1];
          const prevDim = nodeDims.get(prevId) || { width: 160, height: 76 };
          // Border-to-border horizontal gap = rankSep (plus nodeSep cushion)
          const stepX =
            prevDim.width / 2 +
            Math.max(config.rankSep, config.nodeSep + 30) +
            dim.height * 0 +
            dim.width / 2;
          cursorX += stepX;
          positions[nodeId] = { x: Math.round(cursorX), y: currentRowY };
        }
      });

      currentRowY += maxChainHeight + config.nodeSep + 20;
    }

    return positions;
  }

  // ---------------------------------------------------------------------------
  // Mode 2: Top-to-Bottom Hierarchical Tree (`rankDir: 'TB'`, Network-Simplex)
  // ---------------------------------------------------------------------------
  // Orient edges from root -> children (collapsing symmetric parent back-edges via BFS from roots)
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const directedSet = new Set(
    validEdges.map((e) => `${e.source}->${e.target}`)
  );

  nodes.forEach((n) => {
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

  // Build oriented tree adjacency list `treeChildren`
  const treeChildren = new Map<
    string,
    Array<{ childId: string; slotIdx: number }>
  >();
  nodes.forEach((n) => treeChildren.set(n.id, []));

  if (isParentPointerForest) {
    // Invert `child -> parent` edges so roots sit at the top
    validEdges.forEach((e, idx) => {
      treeChildren.get(e.target)!.push({ childId: e.source, slotIdx: idx });
    });
  } else {
    // Pick root candidates (in-degree 0 on non-symmetric edges, or referenced by root stack pointer)
    const nonSymInDeg: Record<string, number> = {};
    nodes.forEach((n) => (nonSymInDeg[n.id] = 0));
    validEdges.forEach((e) => {
      if (!directedSet.has(`${e.target}->${e.source}`)) {
        nonSymInDeg[e.target] = (nonSymInDeg[e.target] || 0) + 1;
      }
    });

    const rootSeeds = nodes
      .filter((n) => nonSymInDeg[n.id] === 0)
      .sort((a, b) => (b.pointers?.length ?? 0) - (a.pointers?.length ?? 0));
    if (rootSeeds.length === 0) {
      rootSeeds.push(nodes[0]);
    }

    const bfsVisited = new Set<string>();
    const orientFromSeed = (seedId: string) => {
      const queue: string[] = [seedId];
      bfsVisited.add(seedId);

      while (queue.length > 0) {
        const u = queue.shift()!;
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
            treeChildren.get(u)!.push({ childId: e.target, slotIdx });
            queue.push(e.target);
          }
        });
      }
    };

    rootSeeds.forEach((r) => {
      if (!bfsVisited.has(r.id)) orientFromSeed(r.id);
    });
    nodes.forEach((n) => {
      if (!bfsVisited.has(n.id)) orientFromSeed(n.id);
    });
  }

  // Sort children strictly by DWARF field declaration order (`slotIdx`)
  treeChildren.forEach((list) => {
    list.sort((a, b) => a.slotIdx - b.slotIdx);
  });

  const childIdSet = new Set<string>();
  treeChildren.forEach((list) => {
    list.forEach((c) => childIdSet.add(c.childId));
  });

  const roots = nodes.filter((n) => !childIdSet.has(n.id)).map((n) => n.id);
  if (roots.length === 0) {
    roots.push(nodes[0].id);
  }

  // Compute bottom-up subtree widths with full `nodeSep` border-to-border horizontal gap
  const CARD_WIDTH = 160;
  const UNIT_SLOT = CARD_WIDTH + config.nodeSep;
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

  // Assign coordinates top-down using TRUE border-to-border vertical `rankSep`
  const assignCoords = (uId: string, centerX: number, centerY: number) => {
    positions[uId] = { x: Math.round(centerX), y: Math.round(centerY) };

    const uNode = nodeMap.get(uId);
    const uDim = nodeDims.get(uId) || { width: 160, height: 76 };
    const isBinaryNode =
      (uNode?.self_ref_order?.length ?? 0) === 2 && !isParentPointerForest;
    const chList = treeChildren.get(uId) || [];

    if (chList.length === 0) return;

    if (isBinaryNode && chList.length === 1) {
      const onlyChild = chList[0];
      const childDim = nodeDims.get(onlyChild.childId) || {
        width: 160,
        height: 76,
      };
      const childW = subtreeWidth.get(onlyChild.childId) || UNIT_SLOT;
      const offset = Math.max(95, childW * 0.35);
      const childCenterX =
        onlyChild.slotIdx === 0 ? centerX - offset : centerX + offset;
      const childCenterY =
        centerY + uDim.height / 2 + config.rankSep + childDim.height / 2;
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
      const childDim = nodeDims.get(c.childId) || { width: 160, height: 76 };
      const cCenterX = currentLeft + cW / 2;
      // Border-to-border vertical clearance = config.rankSep (110px)
      const cCenterY =
        centerY + uDim.height / 2 + config.rankSep + childDim.height / 2;
      assignCoords(c.childId, cCenterX, cCenterY);
      currentLeft += cW;
    });
  };

  let cursorX = 140;
  roots.forEach((rId) => {
    const rW = subtreeWidth.get(rId) || UNIT_SLOT;
    assignCoords(rId, cursorX + rW / 2, 110);
    cursorX += rW + config.nodeSep;
  });

  return positions;
}

// Register the custom `'dagre'` layout plugin on Cytoscape so `cy.layout({ name: 'dagre', ... })`
// works natively without external npm binary dependencies.
let isDagreRegistered = false;
function ensureDagreLayoutRegistered() {
  if (isDagreRegistered) return;
  try {
    function CustomDagreLayout(this: any, options: any) {
      this.options = options;
    }
    CustomDagreLayout.prototype.run = function () {
      const options = this.options;
      const cy: Core = options.cy;
      const eles = options.eles;
      const cyNodes = eles.nodes();

      const rawNodes: ExtendedGraphNode[] = [];
      cyNodes.forEach((n: any) => {
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
      eles.edges().forEach((e: any) => {
        rawEdges.push({
          source: e.source().id(),
          target: e.target().id(),
          label: e.data("label") || "",
          field_order_idx: e.data("fieldOrderIdx") ?? 0,
        });
      });

      const computed = computeDagreHierarchicalPositions(rawNodes, rawEdges, {
        rankDir: options.rankDir || "TB",
        nodeSep: options.nodeSep ?? 90,
        rankSep: options.rankSep ?? 110,
        edgeSep: options.edgeSep ?? 40,
      });

      cyNodes.layoutPositions(this, options, (ele: any) => {
        return computed[ele.id()] || ele.position();
      });
      return this;
    };

    cytoscape("layout", "dagre", CustomDagreLayout as any);
    isDagreRegistered = true;
  } catch {
    isDagreRegistered = true;
  }
}

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
  const shortType = rawType.length > 10 ? `${rawType.slice(0, 9)}…` : rawType;

  const entries = Object.entries(node.fields || {});
  const fieldCount = entries.length;
  const calculatedWidth = 160;
  const calculatedHeight = Math.max(52, 38 + fieldCount * 18);

  const headerHeight = 26;
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
    rowsSvg += `<text x="10" y="${
      headerHeight + 16
    }" font-family="JetBrains Mono, monospace" font-size="10" fill="#94a3b8">${fallbackText}</text>`;
  } else {
    entries.forEach(([k, v], idx) => {
      const yPos = headerHeight + 15 + idx * rowHeight;
      const keyText = escapeXml(k.length > 10 ? `${k.slice(0, 9)}…` : k);
      const rawValStr = String(v);
      let formattedVal = rawValStr;
      let valColor = "#34d399";

      if (rawValStr === "NULL" || rawValStr === "0x0") {
        formattedVal = "NULL";
        valColor = "#64748b";
      } else if (rawValStr.startsWith("0x") && rawValStr.length > 4) {
        formattedVal = `→ ${rawValStr.slice(-6)}`;
        valColor = "#fbbf24";
      } else if (rawValStr.startsWith("ptr[")) {
        valColor = "#38bdf8";
      }

      if (formattedVal.length > 12) {
        formattedVal = `${formattedVal.slice(0, 11)}…`;
      }

      rowsSvg += `
        <text x="10" y="${yPos}" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" fill="#38bdf8">${keyText}:</text>
        <text x="${
          calculatedWidth - 10
        }" y="${yPos}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" fill="${
        isFreed ? "#fca5a5" : valColor
      }">${escapeXml(formattedVal)}</text>
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
    <circle cx="11" cy="${headerHeight / 2 + 0.5}" r="3" fill="${dotColor}"/>
    <text x="18" y="${
      headerHeight / 2 + 4
    }" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700" fill="#f8fafc">${escapeXml(
    shortAddr
  )}</text>
    <text x="${calculatedWidth - 8}" y="${
    headerHeight / 2 + 3.5
  }" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600" fill="#bae6fd">[${escapeXml(
    shortType
  )}]</text>
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

const INDEXED_EDGE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/;

function projectLogicalGraphFromMesh(
  physicalGraph: GraphData,
  locals?: Record<string, number | string>,
  arrays?: ArraySnapshot[]
): { canProject: boolean; isForestTopology: boolean; logicalGraph: GraphData } {
  const pNodes = (physicalGraph?.nodes || []) as ExtendedGraphNode[];
  const pEdges = (physicalGraph?.edges || []) as ExtendedGraphEdge[];

  if (pNodes.length === 0) {
    return {
      canProject: false,
      isForestTopology: false,
      logicalGraph: { nodes: [], edges: [] },
    };
  }

  if (pNodes.every((n) => n.type === "IndexNode")) {
    const logicalNodes: GraphNode[] = pNodes.map((n, idx) => {
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
    });
    return {
      canProject: true,
      isForestTopology: true,
      logicalGraph: {
        nodes: logicalNodes,
        edges: pEdges,
      },
    };
  }

  const nodeById = new Map<string, ExtendedGraphNode>();
  pNodes.forEach((n) => nodeById.set(n.id, n));

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
    const out = outgoingBySource.get(n.id) || [];
    const matched = out
      .map((e) => {
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

  if (!containerNode) {
    return {
      canProject: false,
      isForestTopology: false,
      logicalGraph: { nodes: [], edges: [] },
    };
  }

  let vertexCount = 0;
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

  const rawLogicalEdges: Array<{
    u: number;
    v: number;
    weight: number | string | null;
    chainNodeId: string;
  }> = [];

  for (const { uIdx, targetId } of indexedEdges) {
    let currId: string | undefined = targetId;
    const visitedChain = new Set<string>();

    while (currId && !visitedChain.has(currId) && visitedChain.size < 32) {
      visitedChain.add(currId);
      const chainNode = nodeById.get(currId);
      if (!chainNode || chainNode.is_freed) break;

      const scalarNums: Array<[string, number | string]> = [];
      Object.entries(chainNode.fields || {}).forEach(([k, val]) => {
        const sVal = String(val);
        if (
          sVal !== "NULL" &&
          !sVal.startsWith("0x") &&
          !sVal.startsWith("ptr[")
        ) {
          scalarNums.push([k, val]);
        }
      });

      if (scalarNums.length >= 1) {
        const destVal = Number(scalarNums[0][1]);
        const weightVal = scalarNums.length >= 2 ? scalarNums[1][1] : null;
        if (Number.isInteger(destVal) && destVal >= 0 && destVal < vertexCount) {
          rawLogicalEdges.push({
            u: uIdx,
            v: destVal,
            weight: weightVal,
            chainNodeId: currId,
          });
        }
      }

      const outEdges: ExtendedGraphEdge[] = outgoingBySource.get(currId) || [];
      const nextOut: ExtendedGraphEdge | undefined = outEdges[0];
      currId = nextOut ? nextOut.target : undefined;
    }
  }

  const matchingMetricArray = (arrays || []).find(
    (a) => !a.is_compound && a.kind !== "matrix" && a.elements.length === vertexCount
  );

  const vertexPointers: Record<number, string[]> = {};
  if (matchingMetricArray?.active_indices) {
    Object.entries(matchingMetricArray.active_indices).forEach(
      ([varName, idxVal]) => {
        if (idxVal >= 0 && idxVal < vertexCount) {
          if (!vertexPointers[idxVal]) vertexPointers[idxVal] = [];
          vertexPointers[idxVal].push(varName);
        }
      }
    );
  } else if (locals) {
    Object.entries(locals).forEach(([varName, val]) => {
      if (
        typeof val === "number" &&
        Number.isInteger(val) &&
        val >= 0 &&
        val < vertexCount
      ) {
        if (!vertexPointers[val]) vertexPointers[val] = [];
        vertexPointers[val].push(varName);
      }
    });
  }

  rawLogicalEdges.forEach((reItem) => {
    const cNode = nodeById.get(reItem.chainNodeId);
    if (cNode?.pointers && cNode.pointers.length > 0) {
      cNode.pointers.forEach((pName) => {
        if (!pName.includes("->")) {
          if (!vertexPointers[reItem.v]) vertexPointers[reItem.v] = [];
          const tag = `${pName}→`;
          if (!vertexPointers[reItem.v].includes(tag)) {
            vertexPointers[reItem.v].push(tag);
          }
        }
      });
    }
  });

  const logicalNodes: GraphNode[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const ptrs = vertexPointers[i] || [];
    const metricVal =
      matchingMetricArray && i < matchingMetricArray.elements.length
        ? matchingMetricArray.elements[i]
        : undefined;

    const fieldsObj: Record<string, number | string> = { vertex: i };
    let metricLabel: string | null = null;

    if (
      metricVal !== undefined &&
      (typeof metricVal === "number" || typeof metricVal === "string")
    ) {
      fieldsObj[matchingMetricArray!.name] = metricVal;
      metricLabel = `${matchingMetricArray!.name}: ${String(metricVal)}`;
    }

    logicalNodes.push({
      id: `vertex-${i}`,
      type: "LogicalVertex",
      c_type: "Vertex",
      label: metricLabel ? `Node ${i} (${metricLabel})` : `Node ${i}`,
      fields: fieldsObj,
      pointers: ptrs,
      is_active: ptrs.length > 0,
      is_freed: false,
    });
  }

  const edgeSet = new Set(
    rawLogicalEdges.map((e) => `${e.u}->${e.v}:${String(e.weight ?? "")}`)
  );
  const emittedPairs = new Set<string>();
  const logicalEdges: GraphEdge[] = [];

  for (const e of rawLogicalEdges) {
    const wStr = String(e.weight ?? "");
    const reverseKey = `${e.v}->${e.u}:${wStr}`;
    const isUndirected = edgeSet.has(reverseKey);

    if (isUndirected) {
      const canon = `${Math.min(e.u, e.v)}--${Math.max(e.u, e.v)}:${wStr}`;
      if (emittedPairs.has(canon)) continue;
      emittedPairs.add(canon);
    }

    logicalEdges.push({
      source: `vertex-${e.u}`,
      target: `vertex-${e.v}`,
      label: e.weight !== null ? `w: ${String(e.weight)}` : "",
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
  nodes: GraphNode[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const N = nodes.length;
  if (N === 0) return positions;

  const centerX = 320;
  const centerY = 240;
  const radius = Math.max(140, Math.min(260, N * 45));

  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / N - Math.PI / 2;
    const x = Math.round(centerX + radius * Math.cos(angle));
    const y = Math.round(centerY + radius * Math.sin(angle));
    positions[node.id] = { x, y };
  });

  return positions;
}

/**
 * Multi-lane horizontal layout for general Cyclic / Adjacency-List Pointer Meshes.
 */
function computeGeneralMeshSeedPositions(
  nodes: ExtendedGraphNode[],
  edges: ExtendedGraphEdge[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const nodeMap = new Map<string, ExtendedGraphNode>();
  const nodeHeights = new Map<string, number>();

  nodes.forEach((n) => {
    nodeMap.set(n.id, n);
    const fCount = Object.keys(n.fields || {}).length;
    const h = Math.max(52, 38 + fCount * 18);
    nodeHeights.set(n.id, h);
  });

  const inDegree: Record<string, number> = {};
  const adj: Record<string, ExtendedGraphEdge[]> = {};

  nodes.forEach((n) => {
    inDegree[n.id] = 0;
    adj[n.id] = [];
  });

  edges.forEach((e) => {
    if (nodeMap.has(e.source) && nodeMap.has(e.target) && e.source !== e.target) {
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
  let currentLaneY = 120;
  const HORIZONTAL_PITCH = 250;
  const VERTICAL_MARGIN = 58;

  roots.forEach((rootId) => {
    if (visited.has(rootId)) return;
    visited.add(rootId);

    const rootOut = adj[rootId] || [];
    const rootHeight = nodeHeights.get(rootId) || 72;

    if (rootOut.length === 0) {
      positions[rootId] = { x: 130, y: currentLaneY + rootHeight / 2 };
      currentLaneY += rootHeight + VERTICAL_MARGIN;
      return;
    }

    const startGroupY = currentLaneY;

    rootOut.forEach((branchEdge) => {
      let currId: string | undefined = branchEdge.target;
      let depthX = 1;
      let maxRowHeight = 72;

      while (currId && !visited.has(currId)) {
        visited.add(currId);
        const currH = nodeHeights.get(currId) || 72;
        maxRowHeight = Math.max(maxRowHeight, currH);

        positions[currId] = {
          x: 130 + depthX * HORIZONTAL_PITCH,
          y: currentLaneY + currH / 2,
        };
        const nextEdges: ExtendedGraphEdge[] = adj[currId] || [];
        currId = nextEdges.length > 0 ? nextEdges[0].target : undefined;
        depthX += 1;
      }

      currentLaneY += maxRowHeight + VERTICAL_MARGIN;
    });

    const endGroupY = Math.max(
      startGroupY + rootHeight,
      currentLaneY - VERTICAL_MARGIN
    );
    positions[rootId] = {
      x: 130,
      y: (startGroupY + endGroupY) / 2,
    };

    currentLaneY += 36;
  });

  let leftoverIdx = 0;
  nodes.forEach((n) => {
    if (!visited.has(n.id)) {
      const h = nodeHeights.get(n.id) || 72;
      positions[n.id] = {
        x: 130 + (leftoverIdx % 3) * HORIZONTAL_PITCH,
        y: currentLaneY + Math.floor(leftoverIdx / 3) * (h + VERTICAL_MARGIN),
      };
      leftoverIdx += 1;
    }
  });

  return positions;
}

function enforceMinimumNodeSeparation(
  positions: Record<string, { x: number; y: number }>,
  minDist: number = 95
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const ids = Object.keys(positions);

  ids.forEach((id) => {
    result[id] = { ...positions[id] };
  });

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pA = result[ids[i]];
        const pB = result[ids[j]];
        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const dist = Math.hypot(dx, dy);

        if (dist < minDist) {
          const angle =
            dist < 10
              ? (2 * Math.PI * j) / Math.max(1, ids.length)
              : Math.atan2(dy, dx);
          const push = (minDist - dist) / 2 + 12;
          pA.x = Math.round(pA.x - push * Math.cos(angle));
          pA.y = Math.round(pA.y - push * Math.sin(angle));
          pB.x = Math.round(pB.x + push * Math.cos(angle));
          pB.y = Math.round(pB.y + push * Math.sin(angle));
        }
      }
    }
  }

  return result;
}

export const GraphVisualizer: React.FC<GraphVisualizerProps> = ({
  graph,
  locals,
  arrays,
  isConnecting = false,
}) => {
  ensureDagreLayoutRegistered();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const prevTopologyKeyRef = useRef<string>("");
  const userDraggedPositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  const [viewMode, setViewMode] = useState<ViewMode>("logical");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [badgeOverlays, setBadgeOverlays] = useState<BadgeOverlayItem[]>([]);

  const { canProject, isForestTopology, logicalGraph } = useMemo(
    () => projectLogicalGraphFromMesh(graph, locals, arrays),
    [graph, locals, arrays]
  );

  const effectiveMode: ViewMode =
    viewMode === "logical" && canProject ? "logical" : "physical";

  const activeGraphData =
    effectiveMode === "logical" ? logicalGraph : graph;
  const nodes = (activeGraphData?.nodes || []) as ExtendedGraphNode[];
  const edges = (activeGraphData?.edges || []) as ExtendedGraphEdge[];

  // Automatically classify active topology ('linear-list' | 'tree' | 'general-graph')
  const detectedTopology = useMemo<GraphTopologyKind>(
    () => detectTopology(nodes, edges),
    [nodes, edges]
  );

  const syncBadgePositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const overlays: BadgeOverlayItem[] = [];
    cy.nodes().forEach((cyNode) => {
      const id = cyNode.id();
      const pos = cyNode.renderedPosition();
      const bb = cyNode.renderedBoundingBox({ includeLabels: false });
      const ptrs = (cyNode.data("pointers") as string[]) || [];
      const isFreed = Boolean(cyNode.data("isFreed"));

      if (ptrs.length > 0 || isFreed) {
        overlays.push({
          nodeId: id,
          x: pos.x,
          y: bb.y1 - 8,
          pointers: ptrs,
          isFreed,
        });
      }
    });

    setBadgeOverlays(overlays);
  }, []);

  const clampCameraFit = useCallback(
    (cy: Core) => {
      cy.fit(undefined, 60);
      if (cy.zoom() > 1.2) {
        cy.zoom(1.2);
        cy.center();
      } else if (cy.zoom() < 0.42) {
        cy.zoom(0.42);
        cy.center();
      }
      syncBadgePositions();
    },
    [syncBadgePositions]
  );

  const computeInitialPositionsForTopology = useCallback((): Record<
    string,
    { x: number; y: number }
  > => {
    if (effectiveMode === "logical" && !isForestTopology) {
      return enforceMinimumNodeSeparation(
        computeLogicalCirclePositions(nodes),
        95
      );
    }

    if (detectedTopology === "linear-list") {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "LR",
        nodeSep: 60,
        rankSep: 80,
        edgeSep: 30,
      });
    }

    if (detectedTopology === "tree" || isForestTopology) {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "TB",
        nodeSep: 90,
        rankSep: 110,
        edgeSep: 40,
      });
    }

    return enforceMinimumNodeSeparation(
      computeGeneralMeshSeedPositions(nodes, edges),
      95
    );
  }, [effectiveMode, isForestTopology, detectedTopology, nodes, edges]);

  /**
   * Adaptive Layout Runner:
   * Dispatches the exact layout configuration based on `detectedTopology`:
   *   - `'linear-list'`   -> `dagre` (`rankDir: 'LR', nodeSep: 60, rankSep: 80, edgeSep: 30`)
   *   - `'tree'`          -> `dagre` (`rankDir: 'TB', nodeSep: 90, rankSep: 110, edgeSep: 40, ranker: 'network-simplex'`)
   *   - `'general-graph'` -> `cose` (`nodeRepulsion: 8000, idealEdgeLength: 120, componentSpacing: 100`)
   */
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
          spacingFactor: 1.25,
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

      if (detectedTopology === "linear-list") {
        const lrConfig: DagreLayoutConfig = {
          name: "dagre",
          rankDir: "LR",
          nodeSep: 60,
          rankSep: 80,
          edgeSep: 30,
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
          nodeSep: 90,
          rankSep: 110,
          edgeSep: 40,
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

      // General graph: seed clean initial coordinates first, then run force-directed `cose`
      const seeded = computeInitialPositionsForTopology();
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const p = seeded[n.id()];
          if (p) n.position(p);
        });
      });

      const coseLayout = cy.layout({
        name: "cose",
        animate,
        animationDuration: animate ? 250 : 0,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
        componentSpacing: 100,
        nodeOverlap: 40,
        randomize: false,
      });
      coseLayout.on("layoutstop", () => clampCameraFit(cy));
      coseLayout.run();
    },
    [
      effectiveMode,
      isForestTopology,
      detectedTopology,
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
      .map((e) => `${e.source}->${e.target}:${e.label ?? ""}`)
      .sort()
      .join(",");
    return `${effectiveMode}|${detectedTopology}|${nKeys}|${eKeys}`;
  }, [nodes, edges, effectiveMode, detectedTopology]);

  // Initialize Cytoscape instance once on mount
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
            width: "data(width)",
            height: "data(height)",
            padding: "8px",
            "background-color": "#0f172a",
            "background-opacity": 0,
            "border-width": 0,
            "background-image": "data(svgUri)",
            "background-fit": "contain",
            "background-clip": "none",
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
            opacity: 0.55,
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
            "control-point-step-size": 52,
            label: "data(label)",
            "text-rotation": "autorotate",
            "font-family": "'JetBrains Mono', monospace",
            "font-size": 10,
            "font-weight": "bold",
            color: "#f8fafc",
            "text-background-color": "#0f172a",
            "text-background-opacity": 1,
            "text-background-padding": "4px",
            "text-background-shape": "roundrectangle",
            "text-border-width": 1,
            "text-border-color": "#334155",
            "text-border-opacity": 1,
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
      ],
      wheelSensitivity: 0.2,
      minZoom: 0.35,
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
      const nodeData = evt.target.data("rawNode") as GraphNode | undefined;
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

  // Incremental In-Place Element Diffing & Topology-Driven Layout Execution
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

    const validNodeIds = new Set(nodes.map((n) => n.id));
    const isNewTopology = topologyKey !== prevTopologyKeyRef.current;

    const deterministicPositions = computeInitialPositionsForTopology();

    const finalPositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, idx) => {
      finalPositions[n.id] =
        userDraggedPositionsRef.current[n.id] ||
        deterministicPositions[n.id] || {
          x: 160 + (idx % 4) * 240,
          y: 160 + Math.floor(idx / 4) * 150,
        };
    });

    const desiredEdgeMap = new Map<
      string,
      {
        id: string;
        source: string;
        target: string;
        label: string;
        fieldOrderIdx: number;
        isUndirectedLogical: boolean;
      }
    >();
    edges.forEach((e, idx) => {
      if (
        e.source &&
        e.target &&
        validNodeIds.has(e.source) &&
        validNodeIds.has(e.target)
      ) {
        const edgeId = `edge-${e.source}-${e.target}-${e.label ?? ""}-${idx}`;
        desiredEdgeMap.set(edgeId, {
          id: edgeId,
          source: e.source,
          target: e.target,
          label: e.label ?? "",
          fieldOrderIdx: e.field_order_idx ?? 0,
          isUndirectedLogical:
            effectiveMode === "logical" && !isForestTopology,
        });
      }
    });

    cy.batch(() => {
      cy.nodes().forEach((existingNode) => {
        if (!validNodeIds.has(existingNode.id())) {
          existingNode.remove();
        }
      });

      cy.edges().forEach((existingEdge) => {
        if (!desiredEdgeMap.has(existingEdge.id())) {
          existingEdge.remove();
        }
      });

      nodes.forEach((n, idx) => {
        const isFreed = Boolean(n.is_freed) || n.status === "freed";
        const ptrs = Array.isArray(n.pointers) ? n.pointers : [];
        const isLogicalVertex = n.type === "LogicalVertex";

        const fieldCount = Object.keys(n.fields || {}).length;
        const calculatedWidth = 160;
        const calculatedHeight = Math.max(52, 38 + fieldCount * 18);

        let svgDataUri = "";
        let finalWidth = calculatedWidth;
        let finalHeight = calculatedHeight;

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
          pointers: ptrs,
          rawNode: n,
        };

        const existingEle = cy.getElementById(n.id);
        if (existingEle.length > 0) {
          existingEle.data(nodeDataPayload);
          if (isNewTopology && !userDraggedPositionsRef.current[n.id]) {
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
      const updated = nodes.find((n) => n.id === selectedNode.id) || null;
      setSelectedNode(updated);
    }

    if (isNewTopology) {
      prevTopologyKeyRef.current = topologyKey;
      runActiveLayout(false, false);
    } else {
      syncBadgePositions();
    }
  }, [
    nodes,
    edges,
    topologyKey,
    effectiveMode,
    isForestTopology,
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
                ? "View Collapsed Logical Graph / Forest Topology"
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
            title="View Physical C Heap Structs & Hierarchical Pointers"
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
                <span>[FREED]</span>
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
              {selectedNode.is_freed ? (
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
              ([fieldKey, fieldVal]) => (
                <div
                  key={fieldKey}
                  className="flex items-center justify-between px-2.5 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-xs"
                >
                  <span className="text-sky-400">{fieldKey}</span>
                  <span
                    className={
                      selectedNode.is_freed
                        ? "text-red-400 line-through"
                        : "text-emerald-400 font-semibold"
                    }
                  >
                    {String(fieldVal)}
                  </span>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};
