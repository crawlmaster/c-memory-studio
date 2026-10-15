/**
 * frontend/src/components/Visualizer/GraphVisualizer.tsx
 * Dual-Mode Cytoscape.js Visualizer:
 * 1. Mathematical Graph Mode (`mode === "abstract_graph"` / `node.type === "Vertex"`):
 *    - Renders circular vertex nodes (`0, 1, ..., V-1`) arranged in a clean geometric polygon/circle
 *    - Displays live shortest-path distance (`dist: 0`, `dist: ∞`) and PQ status (`IN_PQ` vs `SETTLED`)
 *    - Renders weighted undirected/directed edges (`w: 9`) with active relaxation highlighting
 *    - Floating algorithm pointer badges (`u ↓`, `v ↓`, `src ↓`)
 * 2. Raw Pointer Mesh Mode (`mode === "pointer_mesh"`):
 *    - Renders compact memory card nodes (`132x52px`), ADT backing buffers (`int[capacity]`),
 *      and `[FREED / DANGLING]` heap chunks in a left-to-right directed rank layout.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { type GraphData, type GraphNode } from "../../types/debug";
import { Share2, RotateCcw, Info, X, AlertOctagon, Network } from "lucide-react";

export interface GraphVisualizerProps {
  graph: GraphData;
  locals?: Record<string, number | string>;
}

interface BadgeOverlayItem {
  nodeId: string;
  x: number;
  y: number;
  pointers: string[];
  isFreed: boolean;
  isBufferBlock: boolean;
}

const POINTER_PILL_COLORS: Record<string, string> = {
  u: "bg-amber-400 text-slate-950 border-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.6)]",
  v: "bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_12px_rgba(217,70,239,0.55)]",
  src: "bg-emerald-400 text-slate-950 border-emerald-200 shadow-[0_0_10px_rgba(52,211,153,0.5)]",
  "crawl->dest": "bg-cyan-400 text-slate-950 border-cyan-200",
  s: "bg-emerald-500 text-slate-950 border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.45)]",
  q: "bg-emerald-500 text-slate-950 border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.45)]",
  head: "bg-emerald-500 text-slate-950 border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.45)]",
  curr: "bg-cyan-400 text-slate-950 border-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.55)]",
  second: "bg-violet-500 text-white border-violet-300 shadow-[0_0_10px_rgba(139,92,246,0.45)]",
  prev: "bg-amber-500 text-slate-950 border-amber-300",
  tail: "bg-fuchsia-500 text-white border-fuchsia-300",
  root: "bg-emerald-500 text-slate-950 border-emerald-300",
};

function getPointerPillStyle(ptrName: string): string {
  if (ptrName.includes("->") && ptrName !== "crawl->dest") {
    return "bg-teal-950/95 text-teal-300 border-teal-500/70 shadow-sm";
  }
  const key = ptrName.toLowerCase();
  return (
    POINTER_PILL_COLORS[key] ||
    "bg-sky-500 text-slate-950 border-sky-300 shadow-sm"
  );
}

function isArrayBufferNode(node: GraphNode): boolean {
  return Boolean(
    (node.type && node.type.includes("[")) ||
      node.fields?.buffer !== undefined
  );
}

/**
 * Computes evenly spaced circular polygon coordinates for mathematical graphs (`0 .. V-1`)
 * so weighted edges never overlap behind colinear vertex boxes.
 */
function computeCircularGraphPositions(
  nodes: GraphNode[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const count = nodes.length;
  if (count === 0) return positions;

  const centerX = 280;
  const centerY = 220;
  const radius = Math.max(135, count * 30);

  nodes.forEach((n, idx) => {
    // Start Vertex 0 at top-left (-110 deg) and proceed clockwise
    const angleRad = ((-110 + (idx * 360) / count) * Math.PI) / 180;
    positions[n.id] = {
      x: Math.round(centerX + radius * Math.cos(angleRad)),
      y: Math.round(centerY + radius * Math.sin(angleRad)),
    };
  });

  return positions;
}

/**
 * Computes left-to-right directed rank coordinates for linked lists, trees, and ADT pointer meshes.
 */
function computeDirectedPositions(
  nodes: GraphNode[],
  edges: Array<{ source: string; target: string; label: string }>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return positions;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};

  nodes.forEach((n) => {
    inDegree[n.id] = 0;
    adj[n.id] = [];
  });

  edges.forEach((e) => {
    if (nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target) {
      adj[e.source].push(e.target);
      inDegree[e.target] = (inDegree[e.target] || 0) + 1;
    }
  });

  const roots = nodes
    .filter((n) => inDegree[n.id] === 0)
    .sort((a, b) => {
      const aHasPrimary = a.pointers?.some((p) =>
        ["head", "s", "q", "root"].includes(p)
      )
        ? -1
        : 0;
      const bHasPrimary = b.pointers?.some((p) =>
        ["head", "s", "q", "root"].includes(p)
      )
        ? -1
        : 0;
      return aHasPrimary - bHasPrimary;
    })
    .map((n) => n.id);

  const visited = new Set<string>();
  const rankBuckets: Record<number, string[]> = {};

  const bfsFromRoot = (startId: string, baseRank: number) => {
    const queue: Array<{ id: string; rank: number }> = [
      { id: startId, rank: baseRank },
    ];
    visited.add(startId);

    while (queue.length > 0) {
      const { id, rank } = queue.shift()!;
      if (!rankBuckets[rank]) {
        rankBuckets[rank] = [];
      }
      rankBuckets[rank].push(id);

      for (const nxt of adj[id] || []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push({ id: nxt, rank: rank + 1 });
        }
      }
    }
  };

  roots.forEach((rId) => {
    if (!visited.has(rId)) {
      bfsFromRoot(rId, 0);
    }
  });

  nodes.forEach((n) => {
    if (!visited.has(n.id)) {
      bfsFromRoot(n.id, 0);
    }
  });

  const HORIZONTAL_STEP = 230;
  const VERTICAL_STEP = 120;

  Object.entries(rankBuckets).forEach(([rankStr, bucketIds]) => {
    const rank = Number(rankStr);
    const count = bucketIds.length;
    bucketIds.forEach((id, rowIdx) => {
      const centeredYOffset = (rowIdx - (count - 1) / 2) * VERTICAL_STEP;
      positions[id] = {
        x: 130 + rank * HORIZONTAL_STEP,
        y: 180 + centeredYOffset,
      };
    });
  });

  return positions;
}

export const GraphVisualizer: React.FC<GraphVisualizerProps> = ({ graph }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const prevTopologyKeyRef = useRef<string>("");

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [badgeOverlays, setBadgeOverlays] = useState<BadgeOverlayItem[]>([]);

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const stackPointers = graph?.stack_pointers || {};
  const isAbstractGraph =
    graph?.mode === "abstract_graph" ||
    nodes.some((n) => n.type === "Vertex");

  const nodePointerMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    nodes.forEach((n) => {
      if (Array.isArray(n.pointers) && n.pointers.length > 0) {
        map[n.id] = [...n.pointers];
      }
    });
    Object.entries(stackPointers).forEach(([ptrName, addr]) => {
      if (!map[addr]) {
        map[addr] = [];
      }
      if (!map[addr].includes(ptrName)) {
        map[addr].push(ptrName);
      }
    });
    return map;
  }, [nodes, stackPointers]);

  const syncBadgePositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const overlays: BadgeOverlayItem[] = [];
    cy.nodes().forEach((cyNode) => {
      const id = cyNode.id();
      const pos = cyNode.renderedPosition();
      const bb = cyNode.renderedBoundingBox({ includeLabels: false });
      const rawNode = cyNode.data("rawNode") as GraphNode | undefined;
      const ptrs = (cyNode.data("pointers") as string[]) || [];
      const isFreed = Boolean(rawNode?.is_freed);
      const isBufferBlock = Boolean(cyNode.data("isBufferBlock"));

      if (ptrs.length > 0 || isFreed) {
        overlays.push({
          nodeId: id,
          x: pos.x,
          y: bb.y1 - 8,
          pointers: ptrs,
          isFreed,
          isBufferBlock,
        });
      }
    });

    setBadgeOverlays(overlays);
  }, []);

  const topologyKey = useMemo(() => {
    const nKeys = nodes
      .map((n) => n.id)
      .sort()
      .join(",");
    const eKeys = edges
      .map((e) => `${e.source ?? e.from}->${e.target ?? e.to}:${e.label}`)
      .sort()
      .join(",");
    return `${isAbstractGraph ? "abstract" : "mesh"}|${nKeys}|${eKeys}`;
  }, [nodes, edges, isAbstractGraph]);

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
            width: 132,
            height: 52,
            "background-color": "#0f172a",
            "border-width": 2,
            "border-color": "#334155",
            label: "data(displayLabel)",
            "text-wrap": "wrap",
            "text-max-width": "124px",
            "text-valign": "center",
            "text-halign": "center",
            "font-family": "'JetBrains Mono', monospace",
            "font-size": 10.5,
            "line-height": 1.35,
            color: "#f1f5f9",
          },
        },
        {
          selector: "node[?isVertex]",
          style: {
            shape: "ellipse",
            width: 68,
            height: 68,
            "background-color": "#0f172a",
            "border-width": 2.5,
            "border-color": "#475569",
            "font-size": 11.5,
            "font-weight": "bold",
            "text-max-width": "62px",
          },
        },
        {
          selector: "node[?isSettled]",
          style: {
            "background-color": "#022c22",
            "border-width": 2.5,
            "border-color": "#10b981",
            color: "#d1fae5",
          },
        },
        {
          selector: "node[?isActive]",
          style: {
            "background-color": "#082f49",
            "border-width": 3,
            "border-color": "#38bdf8",
            color: "#ffffff",
            "overlay-color": "#38bdf8",
            "overlay-padding": 6,
            "overlay-opacity": 0.16,
          },
        },
        {
          selector: "node[?isBufferBlock]",
          style: {
            shape: "round-rectangle",
            width: 162,
            height: 52,
            "background-color": "#022c22",
            "border-width": 2.5,
            "border-color": "#10b981",
            "text-max-width": "152px",
            color: "#d1fae5",
          },
        },
        {
          selector: "node[?isFreed]",
          style: {
            "background-color": "#18181b",
            "border-width": 2,
            "border-style": "dashed",
            "border-color": "#f43f5e",
            opacity: 0.55,
            color: "#fda4af",
            "overlay-opacity": 0,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3.5,
            "border-color": "#f59e0b",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2.2,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.1,
            "curve-style": "bezier",
            label: "data(label)",
            "font-family": "'JetBrains Mono', monospace",
            "font-size": 10,
            color: "#bae6fd",
            "text-background-color": "#020617",
            "text-background-opacity": 0.9,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: "edge[?isUndirected]",
          style: {
            "target-arrow-shape": "none",
            "line-color": "#64748b",
            color: "#e2e8f0",
          },
        },
        {
          selector: "edge[?isActiveEdge]",
          style: {
            width: 3.5,
            "line-color": "#f59e0b",
            "target-arrow-color": "#f59e0b",
            color: "#fef08a",
          },
        },
        {
          selector: "edge[?isDataEdge]",
          style: {
            width: 2.5,
            "line-color": "#10b981",
            "target-arrow-color": "#10b981",
            color: "#6ee7b7",
          },
        },
      ],
      wheelSensitivity: 0.2,
      minZoom: 0.35,
      maxZoom: 2.2,
    });

    cy.on("pan zoom position drag free layoutstop", () => {
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

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const validNodeIds = new Set(nodes.map((n) => n.id));
    const normalizedEdges: Array<{
      source: string;
      target: string;
      label: string;
      isActive: boolean;
      isDirected: boolean;
    }> = [];

    edges.forEach((e) => {
      const src = e.source ?? e.from ?? "";
      const tgt = e.target ?? e.to ?? "";
      if (src && tgt && validNodeIds.has(src) && validNodeIds.has(tgt)) {
        normalizedEdges.push({
          source: src,
          target: tgt,
          label: e.label,
          isActive: Boolean(e.is_active),
          isDirected: e.is_directed !== undefined ? Boolean(e.is_directed) : !isAbstractGraph,
        });
      }
    });

    const isNewTopology = topologyKey !== prevTopologyKeyRef.current;
    const computedPositions = isAbstractGraph
      ? computeCircularGraphPositions(nodes)
      : computeDirectedPositions(nodes, normalizedEdges);

    const existingPositions: Record<string, { x: number; y: number }> = {};
    if (!isNewTopology) {
      cy.nodes().forEach((n) => {
        existingPositions[n.id()] = { ...n.position() };
      });
    }

    const cyNodes: ElementDefinition[] = nodes.map((n) => {
      const isFreed = Boolean(n.is_freed);
      const isBuffer = isArrayBufferNode(n);
      const isVertex = n.type === "Vertex" || isAbstractGraph;
      const isSettled = n.fields?.status === "SETTLED";
      const ptrs = nodePointerMap[n.id] || [];

      let displayLabel = "";
      if (isVertex) {
        const vNum = n.fields?.vertex ?? n.id.replace("node-", "");
        const distVal = n.fields?.dist;
        displayLabel =
          distVal !== undefined && distVal !== "—"
            ? `${vNum}\nd=${distVal}`
            : `${vNum}`;
      } else if (isFreed) {
        const priorVal = n.fields?.val ?? n.fields?.top ?? n.fields?.data;
        displayLabel = `${n.id}\n${
          priorVal !== undefined ? `(was: ${priorVal})` : "tcache freed"
        }`;
      } else if (isBuffer) {
        displayLabel = `${n.id} (${n.type || "array"})\n${String(
          n.fields?.buffer ?? n.label ?? "[]"
        )}`;
      } else {
        const scalarParts: string[] = [];
        Object.entries(n.fields || {}).forEach(([k, v]) => {
          if (v === "NULL" || v === "0x0") {
            scalarParts.push(`${k}: NULL`);
          } else if (typeof v === "string" && v.startsWith("0x")) {
            return;
          } else {
            scalarParts.push(`${k}: ${String(v)}`);
          }
        });
        const secondLine =
          scalarParts.slice(0, 2).join(" · ") || n.label || "struct";
        displayLabel = `${n.id}\n${secondLine}`;
      }

      const pos =
        existingPositions[n.id] ||
        computedPositions[n.id] || { x: 150, y: 150 };

      return {
        group: "nodes",
        position: pos,
        data: {
          id: n.id,
          displayLabel,
          isVertex,
          isSettled,
          isActive: (!isBuffer && ptrs.length > 0) || Boolean(n.is_active),
          isFreed,
          isBufferBlock: isBuffer,
          pointers: ptrs,
          rawNode: n,
        },
      };
    });

    const cyEdges: ElementDefinition[] = normalizedEdges.map((e, idx) => ({
      group: "edges",
      data: {
        id: `edge-${e.source}-${e.target}-${e.label}-${idx}`,
        source: e.source,
        target: e.target,
        label: e.label,
        isActiveEdge: e.isActive,
        isUndirected: isAbstractGraph && !e.isDirected,
        isDataEdge: ["data", "arr", "elements", "buffer", "items"].includes(
          e.label.toLowerCase()
        ),
      },
    }));

    cy.batch(() => {
      cy.elements().remove();
      cy.add([...cyNodes, ...cyEdges]);
    });

    if (selectedNode) {
      const updated = nodes.find((n) => n.id === selectedNode.id) || null;
      setSelectedNode(updated);
    }

    if (isNewTopology && cyNodes.length > 0) {
      prevTopologyKeyRef.current = topologyKey;
      cy.fit(undefined, 65);
      if (cy.zoom() > 1.35) {
        cy.zoom(1.35);
        cy.center();
      }
    }

    syncBadgePositions();
  }, [
    nodes,
    edges,
    topologyKey,
    nodePointerMap,
    selectedNode,
    isAbstractGraph,
    syncBadgePositions,
  ]);

  const handleResetLayout = () => {
    const cy = cyRef.current;
    if (!cy || nodes.length === 0) return;

    const validNodeIds = new Set(nodes.map((n) => n.id));
    const normalizedEdges = edges
      .map((e) => ({
        source: e.source ?? e.from ?? "",
        target: e.target ?? e.to ?? "",
        label: e.label,
      }))
      .filter((e) => validNodeIds.has(e.source) && validNodeIds.has(e.target));

    const freshPositions = isAbstractGraph
      ? computeCircularGraphPositions(nodes)
      : computeDirectedPositions(nodes, normalizedEdges);

    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const targetPos = freshPositions[n.id()];
        if (targetPos) {
          n.position(targetPos);
        }
      });
    });
    cy.fit(undefined, 65);
    if (cy.zoom() > 1.35) {
      cy.zoom(1.35);
      cy.center();
    }
    syncBadgePositions();
  };

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden select-none">
      {/* Top Legend & Re-Center Bar */}
      <div className="absolute top-3 left-3 right-3 z-20 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-xs pointer-events-auto shadow-md">
          {isAbstractGraph ? (
            <>
              <div className="flex items-center gap-1.5 text-sky-400 font-mono text-[11px] font-bold">
                <Network className="w-3.5 h-3.5" />
                <span>Mathematical Graph (V={nodes.length})</span>
              </div>
              <div className="h-3 w-px bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-sky-950 border-2 border-sky-400 inline-block" />
                <span className="text-slate-300 font-mono text-[11px]">
                  Active (u / v)
                </span>
              </div>
              <div className="h-3 w-px bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-emerald-950 border-2 border-emerald-500 inline-block" />
                <span className="text-emerald-300 font-mono text-[11px]">
                  Settled Shortest Path
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-sky-950 border-2 border-sky-400 inline-block" />
                <span className="text-slate-300 font-mono text-[11px]">
                  Struct Node
                </span>
              </div>
              <div className="h-3 w-px bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-emerald-950 border-2 border-emerald-500 inline-block" />
                <span className="text-emerald-300 font-mono text-[11px]">
                  Backing Buffer (int[])
                </span>
              </div>
              <div className="h-3 w-px bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-zinc-900 border border-dashed border-rose-500 inline-block opacity-75" />
                <span className="text-rose-300 font-mono text-[11px]">
                  Freed / Dangling
                </span>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={handleResetLayout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono pointer-events-auto shadow-md transition cursor-pointer"
          title="Auto-Align & Fit Graph Nodes"
        >
          <RotateCcw className="w-3.5 h-3.5 text-sky-400" />
          <span>Align &amp; Fit</span>
        </button>
      </div>

      {/* Empty State */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 p-8 text-center z-0">
          <Share2 className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
          <p className="text-sm font-medium text-slate-300">
            No Active Graph or Struct Pointers in Scope
          </p>
          <p className="text-xs text-slate-500 max-w-md mt-1">
            Step through code that allocates a Graph (e.g.{" "}
            <code className="text-sky-400">Graph *g = create_graph(V)</code>) or
            struct pointers to visualize vertices, edges, and heap containers.
          </p>
        </div>
      )}

      {/* Cytoscape Canvas */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Floating Stack Pointer & [FREED / DANGLING] Badges Layer */}
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
              <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-950/95 border border-rose-500 text-rose-200 font-mono text-[10px] font-extrabold tracking-tight shadow-lg whitespace-nowrap">
                <AlertOctagon className="w-3 h-3 text-rose-400 shrink-0" />
                <span>[FREED / DANGLING]</span>
              </div>
            )}

            {item.pointers.length > 0 && (
              <div className="flex items-center gap-1">
                {item.pointers.map((ptrName) => (
                  <div
                    key={ptrName}
                    className={`px-2 py-0.5 rounded-full font-mono text-[11px] font-extrabold border whitespace-nowrap transition-all duration-200 ${getPointerPillStyle(
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
                {selectedNode.type === "Vertex"
                  ? `Vertex ${selectedNode.fields?.vertex ?? selectedNode.id}`
                  : selectedNode.id}
              </span>
              {selectedNode.is_freed ? (
                <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/50 text-rose-300 text-[10px] font-mono font-bold">
                  FREED / DANGLING
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-mono">
                  {String(selectedNode.fields?.status || selectedNode.type || "LIVE")}
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

          {(nodePointerMap[selectedNode.id]?.length ?? 0) > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 mb-2.5">
              <span className="text-[11px] font-mono text-slate-400">
                Active Variables:
              </span>
              {nodePointerMap[selectedNode.id].map((p) => (
                <span
                  key={p}
                  className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-sky-300 font-mono text-[11px]"
                >
                  {p}
                </span>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            {Object.entries(selectedNode.fields || {}).map(
              ([fieldKey, fieldVal]) => (
                <div
                  key={fieldKey}
                  className="flex items-center justify-between px-2.5 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-xs"
                >
                  <span className="text-slate-400">{fieldKey}</span>
                  <span
                    className={
                      selectedNode.is_freed
                        ? "text-rose-400 line-through"
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
