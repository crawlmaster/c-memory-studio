/**
 * frontend/src/components/Visualizer/GraphVisualizer.tsx
 * Topology-Aware DWARF Graph, Tree, Linear-List & Pointer Mesh Visualizer.
 *
 * Key Capabilities:
 * 1. Atomic Traversal-Pointer Driven Edge & Weight Activation (Zero One-Step Lag):
 *    - As soon as a frame pointer references a physical edge struct `E` in the heap,
 *      the incident logical edge `(vertex-u -> vertex-v)` and its weight badge activate
 *      IMMEDIATELY from `E`'s physical fields without waiting for local scalar copies
 *      to finish executing.
 * 2. Zero-Hardcoding Metric vs. Vertex Discrimination (`knownMetricVarsRef` & Single-Owner Endpoints):
 *    - Prevents edge-weight and distance-metric scalars from ever rendering above vertex
 *      circles, including on intermediate steps before a metric assignment line executes.
 *    - Binds active metric variables exclusively to the active logical edge `(vertex-u -> vertex-v)`.
 * 3. Parallel Edge Separation, Container Isolation & Responsive Topology Updates.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import cytoscape from "cytoscape";
import type { Core, LayoutOptions } from "cytoscape";
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
export type GraphTopologyKind = "linear-list" | "tree" | "general-graph";

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
  nodeSep?: number;
  rankSep?: number;
  edgeSep?: number;
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

function normalizeStructType(node: ExtendedGraphNode): string {
  return (node.c_type || node.type || "struct")
    .replace(/^const\s+/, "")
    .replace(/^struct\s+/, "")
    .trim();
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
      backboneEdges: edges,
    };
  }

  const nodeById = new Map<string, ExtendedGraphNode>();
  nodes.forEach((n) => nodeById.set(n.id, n));

  const validEdges: ExtendedGraphEdge[] = edges.filter(
    (e) =>
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
  ).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target
  );

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
      compNodes.forEach((u) => {
        const nbrs = undirNeighbors.get(u);
        if (nbrs) {
          nbrs.forEach((v) => {
            if (u < v) compUndirEdgeCount += 1;
          });
        }
      });

      if (compUndirEdgeCount >= compNodes.length) {
        hasUndirectedCycle = true;
      }
    }
  }

  if (hasUndirectedCycle) {
    return "general-graph";
  }

  const directedPairSet = new Set<string>(
    validEdges.map((e) => `${e.source}->${e.target}`)
  );

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

const INDEXED_EDGE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/;

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

  const effectiveNodeSep = Math.max(80, config.nodeSep);
  const effectiveRankSep = Math.max(110, config.rankSep);

  const nodeMap = new Map<string, ExtendedGraphNode>();
  const nodeDims = new Map<string, { width: number; height: number }>();

  nodes.forEach((n) => {
    nodeMap.set(n.id, n);
    const fCount = Object.keys(n.fields || {}).length;
    const width = 160;
    const height = Math.max(52, 38 + fCount * 18);
    nodeDims.set(n.id, { width, height });
  });

  const allValidEdges: ExtendedGraphEdge[] = edges.filter(
    (e) => nodeMap.has(e.source) && nodeMap.has(e.target) && e.source !== e.target
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
      ? 140 + 160 + effectiveRankSep + 30
      : 140;
    let currentRowY =
      containerNodes.length > 0 && !isMultiLaneContainer ? 260 : 140;

    chains.forEach((chain) => {
      let cursorX = chainStartX;
      let maxChainHeight = 76;

      chain.forEach((nodeId, idx) => {
        const dim = nodeDims.get(nodeId) || { width: 160, height: 76 };
        maxChainHeight = Math.max(maxChainHeight, dim.height);
        if (idx === 0) {
          positions[nodeId] = { x: cursorX, y: currentRowY + dim.height / 2 };
        } else {
          const prevId = chain[idx - 1];
          const prevDim = nodeDims.get(prevId) || { width: 160, height: 76 };
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

        const cDim = nodeDims.get(cNode.id) || { width: 160, height: 84 };

        if (isMultiLaneContainer && cTargets.length > 0) {
          const minY = Math.min(...cTargets.map((pos) => pos.y));
          const maxY = Math.max(...cTargets.map((pos) => pos.y));
          positions[cNode.id] = {
            x: 140,
            y: Math.round(
              (minY + maxY) / 2 + cIdx * (cDim.height + effectiveNodeSep)
            ),
          };
        } else if (cTargets.length > 0) {
          const avgX =
            cTargets.reduce((sum, pos) => sum + pos.x, 0) / cTargets.length;
          const minY = Math.min(...cTargets.map((pos) => pos.y));
          positions[cNode.id] = {
            x: Math.round(avgX + cIdx * 220),
            y: Math.round(minY - cDim.height / 2 - effectiveRankSep),
          };
        } else {
          positions[cNode.id] = {
            x: 140 + cIdx * 240,
            y: 100,
          };
        }
      });
    }

    return positions;
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

  const CARD_WIDTH = 160;
  const UNIT_SLOT = CARD_WIDTH + effectiveNodeSep;
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
      const offset = Math.max(105, childW * 0.35);
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
      const childDim = nodeDims.get(c.childId) || { width: 160, height: 76 };
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
    containerNodes.length > 0 && !isMultiTreeContainer ? 260 : 120;
  let cursorX = isMultiTreeContainer
    ? 140 + 160 + effectiveRankSep + 30
    : 140;

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
      const cDim = nodeDims.get(cNode.id) || { width: 160, height: 84 };

      if (isMultiTreeContainer && cTargets.length > 0) {
        const minY = Math.min(...cTargets.map((pos) => pos.y));
        const maxY = Math.max(...cTargets.map((pos) => pos.y));
        positions[cNode.id] = {
          x: 140,
          y: Math.round(
            (minY + maxY) / 2 + cIdx * (cDim.height + effectiveNodeSep)
          ),
        };
      } else if (cTargets.length > 0) {
        const avgX =
          cTargets.reduce((sum, pos) => sum + pos.x, 0) / cTargets.length;
        const minY = Math.min(...cTargets.map((pos) => pos.y));
        positions[cNode.id] = {
          x: Math.round(avgX + cIdx * 220),
          y: Math.round(minY - cDim.height / 2 - effectiveRankSep),
        };
      } else {
        positions[cNode.id] = {
          x: 140 + cIdx * 220,
          y: 80,
        };
      }
    });
  }

  return positions;
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
        rawEdges.push({
          source: e.source().id(),
          target: e.target().id(),
          label: String(e.data("label") ?? ""),
          field_order_idx: Number(e.data("fieldOrderIdx") ?? 0),
        });
      });

      const computed = computeDagreHierarchicalPositions(rawNodes, rawEdges, {
        rankDir: options.rankDir || "TB",
        nodeSep: Math.max(80, options.nodeSep ?? 90),
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

      const strikeAttr = isFreed ? 'text-decoration="line-through"' : "";

      rowsSvg += `
        <text x="10" y="${yPos}" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" fill="${
          isFreed ? "#f87171" : "#38bdf8"
        }">${keyText}:</text>
        <text x="${
          calculatedWidth - 10
        }" y="${yPos}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" ${strikeAttr} fill="${
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
 * Atomic Traversal-Pointer Driven Logical Graph & Edge-Metric Projection:
 *
 * 1. Immediate Active Edge Resolution via Traversal Pointer:
 *    - When any stack pointer references a physical edge struct `E` in bucket `u`,
 *      the directed edge `(vertex-u -> vertex-v)` and its weight badge (`w: ${weight}`)
 *      activate IMMEDIATELY on that step (`is_active_edge = true`, `has_active_metric = true`),
 *      without waiting for local scalar copies to be evaluated.
 * 2. Zero Transient Metric Placement on Vertex Nodes:
 *    - Tracks variables that act as edge/distance metrics (`knownMetricVars`) and variables
 *      that act as proven vertex endpoints (`knownVertexVars`).
 *    - During active edge traversal `(actU -> actV)`, at most ONE scalar variable can bind
 *      to `actU` and at most ONE scalar variable (the first established endpoint variable)
 *      can bind to `actV`. Any second variable or known metric variable is strictly excluded
 *      from `vertexPointers` and bound to the active edge `(vertex-actU -> vertex-actV)`.
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
  const pEdges = (physicalGraph?.edges || []) as ExtendedGraphEdge[];

  // Case 1: Index-Buffer Forest Topology (e.g. Disjoint Set Union parent[] array)
  if (
    (backendLogical && backendLogical.is_forest) ||
    (pNodes.length > 0 && pNodes.every((n) => n.type === "IndexNode"))
  ) {
    const sourceNodes =
      backendLogical && backendLogical.nodes.length > 0
        ? backendLogical.nodes
        : pNodes;
    const sourceEdges =
      backendLogical && backendLogical.edges.length > 0
        ? backendLogical.edges
        : pEdges;

    const logicalNodes: ExtendedGraphNode[] = sourceNodes
      .filter((n) => !n.is_freed && n.status !== "freed")
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
    if (n.is_freed || n.status === "freed") continue;
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

  // Classify `locals`: record pointer addresses, scalar integers, and any out-of-vertex-domain
  // metric values (e.g. `INF` / `∞` or values `> vertexCount`)
  const addrToLocalPtrNames = new Map<string, string[]>();
  const scalarLocals = new Map<string, number>();

  if (locals) {
    Object.entries(locals).forEach(([varName, rawVal]) => {
      const strVal = String(rawVal).trim();
      if (strVal.startsWith("0x") || strVal.startsWith("0X")) {
        const normAddr = strVal.toLowerCase();
        if (!addrToLocalPtrNames.has(normAddr)) {
          addrToLocalPtrNames.set(normAddr, []);
        }
        addrToLocalPtrNames.get(normAddr)!.push(varName);
      } else if (strVal === "∞" || strVal === "-∞") {
        // Any variable that holds infinity is a distance/cost metric, never a vertex index
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

  // Walk physical bucket chains to discover physical edge structs and detect active pointer traversal
  const discoveredEdges: DiscoveredPhysicalEdge[] = [];

  for (const { uIdx, targetId } of indexedEdges) {
    let currId: string | undefined = targetId;
    const visitedChain = new Set<string>();

    while (currId && !visitedChain.has(currId) && visitedChain.size < 32) {
      visitedChain.add(currId);
      const chainNode = nodeById.get(currId);
      if (!chainNode) break;

      const isChainNodeFreed =
        Boolean(chainNode.is_freed) || chainNode.status === "freed";

      if (!isChainNodeFreed) {
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
      const nextOut: ExtendedGraphEdge | undefined = outEdges[0];
      currId = nextOut ? nextOut.target : undefined;
    }
  }

  // Identify 1D vertex-domain buffers (arrays with length === vertexCount)
  const vertexDomainArrays: ArraySnapshot[] = (arrays || []).filter(
    (a) =>
      !a.is_compound && a.kind !== "matrix" && a.elements.length === vertexCount
  );
  const primaryMetricArray: ArraySnapshot | undefined = vertexDomainArrays[0];

  // Collect candidate vertex cursors from `active_indices` of vertex-domain arrays
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

  // Resolve the currently active physical edge directly from the traversal pointer
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

    // 1. Identify the single owner variable for `actU` (source bucket vertex)
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

    // 2. Identify the single owner variable for `actV` (destination vertex):
    //    If multiple variables currently hold `actV` (e.g. `v = 1` and stale `w = 1` on the
    //    step `int w = curr->weight;`), ONLY the first/established vertex variable (`chosenVVar`)
    //    binds to `actV`. Any second variable holding `actV` is classified as a metric variable!
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
          // Second variable colliding on `actV` during edge traversal is the metric variable
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

    // 3. Classify any remaining local scalar variables that match `metricValues`
    //    (and are not `chosenUVar` or `chosenVVar`) as edge-metric variables
    scalarLocals.forEach((val, varName) => {
      if (varName !== chosenUVar && varName !== chosenVVar) {
        if (metricValues.includes(val)) {
          knownMetricVars.add(varName);
        }
      }
    });

    // 4. Bind the active edge metric label atomically via the traversal pointer:
    //    Find the active metric variable name (either matching `metricValues` now, or
    //    already known in `knownMetricVars` and present in `scalarLocals`), and bind it
    //    directly to `activePhysicalEdge`'s true weight `actWeight` so there is ZERO 1-step lag!
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

    // 5. Attach traversal struct pointer indicator (`curr→`) to `actV`
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
    // No active edge traversal pointer (`curr` is NULL or out of scope):
    // Render proven vertex cursors while excluding all `knownMetricVars`
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

  // Construct Logical Vertex Nodes (`vertex-0 .. vertex-(V-1)`)
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

  // Construct Logical Edges
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
    // Activate the amber weight badge pill IMMEDIATELY whenever `isEdgeActive` is true!
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
  const radius = Math.max(140, Math.min(260, N * 45));

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
  const HORIZONTAL_PITCH = 280;
  const VERTICAL_MARGIN = 90;

  roots.forEach((rootId) => {
    if (visited.has(rootId)) return;
    visited.add(rootId);

    const rootOut = adj[rootId] || [];
    const rootHeight = nodeHeights.get(rootId) || 72;

    if (rootOut.length === 0) {
      positions[rootId] = { x: 140, y: currentLaneY + rootHeight / 2 };
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
          x: 140 + depthX * HORIZONTAL_PITCH,
          y: currentLaneY + currH / 2,
        };
        const nextEdges: ExtendedGraphEdge[] = adj[currId] || [];
        const firstNext: ExtendedGraphEdge | undefined = nextEdges[0];
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
      x: 140,
      y: (startGroupY + endGroupY) / 2,
    };

    currentLaneY += 45;
  });

  let leftoverIdx = 0;
  nodes.forEach((n) => {
    if (!visited.has(n.id)) {
      const h = nodeHeights.get(n.id) || 72;
      positions[n.id] = {
        x: 140 + (leftoverIdx % 3) * HORIZONTAL_PITCH,
        y: currentLaneY + Math.floor(leftoverIdx / 3) * (h + VERTICAL_MARGIN),
      };
      leftoverIdx += 1;
    }
  });

  return positions;
}

function enforceMinimumNodeSeparation(
  positions: Record<string, { x: number; y: number }>,
  minDist: number = 110
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
          const push = (minDist - dist) / 2 + 14;
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

  // Session-persistent classification sets to eliminate transient 1-step metric jumps
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
  const nodes: ExtendedGraphNode[] = activeGraphData?.nodes || [];
  const edges: ExtendedGraphEdge[] = activeGraphData?.edges || [];

  const detectedTopology = useMemo<GraphTopologyKind>(
    () => detectTopology(nodes, edges),
    [nodes, edges]
  );

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
          y: bb.y1 - 8,
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
        105
      );
    }

    if (detectedTopology === "linear-list") {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "LR",
        nodeSep: 85,
        rankSep: 115,
        edgeSep: 40,
      });
    }

    if (detectedTopology === "tree" || isForestTopology) {
      return computeDagreHierarchicalPositions(nodes, edges, {
        rankDir: "TB",
        nodeSep: 95,
        rankSep: 120,
        edgeSep: 45,
      });
    }

    return enforceMinimumNodeSeparation(
      computeGeneralMeshSeedPositions(nodes, edges),
      115
    );
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
          nodeSep: 85,
          rankSep: 115,
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
          nodeSep: 95,
          rankSep: 120,
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
        animate,
        animationDuration: animate ? 250 : 0,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 450000,
        idealEdgeLength: () => 220,
        edgeElasticity: () => 0.25,
        componentSpacing: 120,
        nodeOverlap: 60,
        gravity: 0.15,
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
            width: "data(width)",
            height: "data(height)",
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
            "control-point-step-size": 58,
            "edge-distances": "node-position",
            label: "data(label)",
            "text-rotation": "autorotate",
            "text-margin-y": -8,
            "font-family": "'JetBrains Mono', monospace",
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

    const finalPositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, idx) => {
      finalPositions[n.id] =
        userDraggedPositionsRef.current[n.id] ||
        deterministicPositions[n.id] || {
          x: 160 + (idx % 4) * 260,
          y: 160 + Math.floor(idx / 4) * 165,
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
        isActiveEdge: boolean;
        hasActiveMetricBadge: boolean;
        isDeleting: boolean;
      }
    >();

    const activeCanonicalPairs = new Set<string>();
    const pairOccurrenceCounter = new Map<string, number>();

    edges.forEach((e) => {
      if (
        e.source &&
        e.target &&
        validNodeIds.has(e.source) &&
        validNodeIds.has(e.target)
      ) {
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
          isDangling,
          isDeleting: false,
          pointers: ptrs,
          rawNode: n,
        };

        const existingEle = cy.getElementById(n.id);
        if (existingEle.length > 0) {
          existingEle.data(nodeDataPayload);
          if (!hadPreviousNodes && isNewTopology) {
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
            title="View Physical C Heap Structs, Dangling Pointers & [FREED] Blocks"
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
              ([fieldKey, fieldVal]) => (
                <div
                  key={fieldKey}
                  className="flex items-center justify-between px-2.5 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-xs"
                >
                  <span className="text-sky-400">{fieldKey}</span>
                  <span
                    className={
                      selectedNode.is_freed || selectedNode.status === "freed"
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
