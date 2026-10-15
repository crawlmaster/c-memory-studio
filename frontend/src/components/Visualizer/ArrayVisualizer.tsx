/**
 * frontend/src/components/Visualizer/ArrayVisualizer.tsx
 * Generic DWARF Array & Compound Struct-Array Visualizer.
 * Features:
 * - Supports both primitive arrays (`[2, 5, 8, "∞"]`) and compound struct arrays
 *   (`[{ fields: { v: 0, dist: 9 } }, ...]`).
 * - For compound struct elements: renders all DWARF scalar fields as clean key-value tags
 *   inside each cell card and dynamically scales bar height using the first non-ID numeric field.
 * - Renders all syntactically proven `active_indices` (`i ↓`, `j ↓`, `low ↓`, `middle ↓`, `top ↓`)
 *   above their target cells with deterministic color badges (zero hardcoded name filtering).
 * - Displays all in-scope scalar variables (`target`, `swapped`, `sum`, etc.) in the
 *   "Stack Frame Locals" footer panel.
 */

import React from "react";
import {
  type ArraySnapshot,
  type ArrayElement,
  type CompoundArrayElement,
  type GraphNode,
} from "../../types/debugger";
import { BarChart3, Database, Layers } from "lucide-react";

export interface ArrayVisualizerProps {
  arrays: ArraySnapshot[];
  locals?: Record<string, number | string>;
  graphNodes?: GraphNode[];
}

const BADGE_PALETTE = [
  "bg-sky-400 text-slate-950 border-sky-200 shadow-[0_0_10px_rgba(56,189,248,0.45)]",
  "bg-amber-400 text-slate-950 border-amber-200 shadow-[0_0_10px_rgba(251,191,36,0.45)]",
  "bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_10px_rgba(217,70,239,0.45)]",
  "bg-emerald-400 text-slate-950 border-emerald-200 shadow-[0_0_10px_rgba(52,211,153,0.45)]",
  "bg-violet-500 text-white border-violet-300",
  "bg-cyan-400 text-slate-950 border-cyan-200",
  "bg-orange-400 text-slate-950 border-orange-200",
  "bg-rose-500 text-white border-rose-300",
];

function getIndexBadgeStyle(pointerName: string): string {
  let hash = 0;
  for (let i = 0; i < pointerName.length; i++) {
    hash = (hash * 31 + pointerName.charCodeAt(i)) >>> 0;
  }
  return BADGE_PALETTE[hash % BADGE_PALETTE.length];
}

function isCompoundElement(el: ArrayElement): el is CompoundArrayElement {
  return (
    el !== null &&
    typeof el === "object" &&
    "fields" in el &&
    el.fields !== null &&
    typeof el.fields === "object"
  );
}

interface NormalizedCell {
  isCompound: boolean;
  fields: Array<[string, number | string]>;
  scalarText: string;
  barMetric: number;
  isInfinity: boolean;
}

/**
 * Normalizes any ArrayElement (primitive or compound DWARF struct record)
 * into a uniform cell representation.
 * For compound structs with multiple numeric fields (e.g. `{ v: 2, dist: 6 }`),
 * picks the first non-ID numeric field (index 1 if >=2 numeric fields, else index 0)
 * to scale the vertical comparison bar.
 */
function normalizeArrayElement(el: ArrayElement): NormalizedCell {
  if (isCompoundElement(el)) {
    const entries = Object.entries(el.fields);
    const numericCandidates: Array<{ val: number; isInf: boolean }> = [];

    entries.forEach(([, rawV]) => {
      if (rawV === "∞") {
        numericCandidates.push({ val: 0, isInf: true });
      } else {
        const parsed = typeof rawV === "number" ? rawV : Number(rawV);
        if (Number.isFinite(parsed)) {
          numericCandidates.push({ val: parsed, isInf: false });
        }
      }
    });

    const chosenMetric =
      numericCandidates.length >= 2
        ? numericCandidates[1]
        : numericCandidates[0] || { val: 0, isInf: false };

    return {
      isCompound: true,
      fields: entries,
      scalarText: entries.map(([k, v]) => `${k}: ${String(v)}`).join(", "),
      barMetric: chosenMetric.val,
      isInfinity: chosenMetric.isInf,
    };
  }

  // Fallback for legacy object with `{ label, value }` if present
  if (el !== null && typeof el === "object" && "value" in (el as Record<string, unknown>)) {
    const rawObj = el as Record<string, unknown>;
    const rawVal = rawObj.value;
    const isInf = rawVal === "∞";
    const num = typeof rawVal === "number" ? rawVal : Number(rawVal);
    const entries: Array<[string, number | string]> = [];
    if (typeof rawObj.secondary === "string") {
      const [k, v] = rawObj.secondary.split("=");
      if (k && v !== undefined) entries.push([k, v]);
    }
    entries.push(["val", String(rawVal ?? "")]);
    return {
      isCompound: true,
      fields: entries,
      scalarText: String(rawObj.label ?? rawVal ?? ""),
      barMetric: Number.isFinite(num) ? num : 0,
      isInfinity: isInf,
    };
  }

  const strVal = String(el);
  const isInf = strVal === "∞";
  const num = typeof el === "number" ? el : Number(el);

  return {
    isCompound: false,
    fields: [],
    scalarText: strVal,
    barMetric: Number.isFinite(num) ? num : 0,
    isInfinity: isInf,
  };
}

export const ArrayVisualizer: React.FC<ArrayVisualizerProps> = ({
  arrays,
  locals,
  graphNodes = [],
}) => {
  if (!arrays || arrays.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
        <BarChart3 className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
        <p className="text-sm font-medium text-slate-300">
          No Contiguous Arrays or Struct Buffers in Current Scope
        </p>
        <p className="text-xs text-slate-500 max-w-md mt-1">
          Start a GDB trace or step into a function containing stack arrays,
          heap buffers, or struct-embedded dynamic arrays to inspect elements
          and active index cursors.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-5 overflow-y-auto h-full bg-slate-950">
      {arrays.map((arr) => {
        const isStructOwned =
          arr.name.includes("->") || arr.name.includes(".");
        const ownerVar = isStructOwned ? arr.name.split(/->|\./)[0] : null;
        const ownerNode = ownerVar
          ? graphNodes.find((n) => n.pointers?.includes(ownerVar))
          : undefined;

        const cells = arr.elements.map(normalizeArrayElement);
        const hasCompoundCells =
          Boolean(arr.is_compound) || cells.some((c) => c.isCompound);

        const maxMetric = Math.max(
          ...cells.map((c) => Math.abs(c.barMetric)),
          1
        );

        // Map in-bounds index -> list of active index variable names
        const indexToPointers: Record<number, string[]> = {};
        Object.entries(arr.active_indices || {}).forEach(([ptrName, idxVal]) => {
          if (
            typeof idxVal === "number" &&
            idxVal >= 0 &&
            idxVal < arr.elements.length
          ) {
            if (!indexToPointers[idxVal]) {
              indexToPointers[idxVal] = [];
            }
            indexToPointers[idxVal].push(ptrName);
          }
        });

        return (
          <div
            key={arr.name}
            className="rounded-xl bg-slate-900/95 border border-slate-800 p-5 shadow-lg"
          >
            {/* Array Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-500/10 border border-sky-500/30 text-sky-400 font-mono text-xs font-semibold">
                  {isStructOwned && <Database className="w-3.5 h-3.5" />}
                  <span>{arr.element_type || arr.type || "int"}[]</span>
                </span>

                <h3 className="text-base font-mono font-bold text-slate-100">
                  {arr.name}
                </h3>

                <span className="text-xs text-slate-400 font-mono">
                  ({arr.elements.length}
                  {arr.capacity && arr.capacity !== arr.elements.length
                    ? ` / capacity: ${arr.capacity}`
                    : " elements"}
                  )
                </span>

                {ownerNode && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300">
                    <Layers className="w-3 h-3 text-sky-400" />
                    <span>
                      {ownerNode.c_type || ownerNode.type || "struct"} @{" "}
                      {ownerNode.id}
                    </span>
                  </span>
                )}
              </div>

              {/* Syntactically Proven Active Index Legend */}
              <div className="flex flex-wrap items-center gap-2">
                {Object.entries(arr.active_indices || {}).map(
                  ([ptrName, idxVal]) => {
                    const isOutOfBounds =
                      idxVal < 0 || idxVal >= arr.elements.length;
                    return (
                      <span
                        key={ptrName}
                        className={`px-2.5 py-0.5 rounded text-[11px] font-mono font-bold border ${getIndexBadgeStyle(
                          ptrName
                        )} ${isOutOfBounds ? "opacity-65" : ""}`}
                        title={
                          isOutOfBounds
                            ? `Boundary index (${idxVal}) outside [0, ${
                                arr.elements.length - 1
                              }]`
                            : `Indexing ${arr.name}[${idxVal}]`
                        }
                      >
                        {ptrName} = {idxVal}
                        {idxVal === -1
                          ? " (-1)"
                          : isOutOfBounds
                          ? " (end)"
                          : ""}
                      </span>
                    );
                  }
                )}
              </div>
            </div>

            {/* Bars + Element Cards Strip */}
            <div className="overflow-x-auto pb-2">
              <div className="inline-flex items-end gap-3.5 min-w-full pt-12 pb-2 px-2">
                {cells.map((cell, idx) => {
                  const heightPct = cell.isInfinity
                    ? 16
                    : Math.max(
                        12,
                        Math.round((Math.abs(cell.barMetric) / maxMetric) * 100)
                      );
                  const activePtrs = indexToPointers[idx] || [];
                  const isHighlighted = activePtrs.length > 0;

                  return (
                    <div
                      key={`${arr.name}-idx-${idx}`}
                      className={`flex flex-col items-center group ${
                        hasCompoundCells ? "min-w-[92px]" : "min-w-[58px]"
                      }`}
                    >
                      {/* Floating Active Index Pointer Badges */}
                      <div className="min-h-[32px] flex flex-col items-center justify-end gap-1 mb-1.5">
                        {activePtrs.map((ptr) => (
                          <div
                            key={ptr}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-extrabold border shadow-sm transition-all duration-200 whitespace-nowrap ${getIndexBadgeStyle(
                              ptr
                            )}`}
                          >
                            {ptr} ↓
                          </div>
                        ))}
                      </div>

                      {/* Vertical Magnitude Bar */}
                      <div
                        className={`h-28 ${
                          hasCompoundCells ? "w-16" : "w-12"
                        } bg-slate-950/80 rounded-t-lg border border-b-0 border-slate-800/90 flex items-end p-1 overflow-hidden`}
                      >
                        <div
                          style={{ height: `${heightPct}%` }}
                          className={`w-full rounded-t transition-all duration-300 ease-out ${
                            isHighlighted
                              ? "bg-gradient-to-t from-sky-600 to-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]"
                              : "bg-gradient-to-t from-slate-700 to-slate-500"
                          }`}
                        />
                      </div>

                      {/* Element Card (Primitive Scalar OR Generic DWARF Struct Fields Card) */}
                      <div
                        className={`w-full py-2 px-2.5 text-center font-mono border rounded-b-md transition-all duration-300 ${
                          isHighlighted
                            ? "bg-sky-950/95 border-sky-400 text-sky-100 shadow-md scale-105 z-10"
                            : "bg-slate-950 border-slate-800 text-slate-200"
                        }`}
                      >
                        {cell.isCompound && cell.fields.length > 0 ? (
                          <div className="flex flex-col gap-1 text-left">
                            {cell.fields.map(([fKey, fVal], fIdx) => (
                              <div
                                key={fKey}
                                className={`flex items-center justify-between gap-2 px-1.5 py-0.5 rounded text-[11px] ${
                                  fIdx === 0
                                    ? "bg-slate-900 text-sky-300 border border-slate-800"
                                    : "text-emerald-300 font-bold"
                                }`}
                              >
                                <span className="text-slate-400">{fKey}:</span>
                                <span>{String(fVal)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-sm font-bold">
                            {cell.scalarText}
                          </span>
                        )}
                      </div>

                      {/* Array Index Footer `[idx]` */}
                      <div
                        className={`mt-1.5 text-[11px] font-mono ${
                          isHighlighted
                            ? "text-sky-400 font-bold"
                            : "text-slate-500"
                        }`}
                      >
                        [{idx}]
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {/* Dedicated Stack Frame Locals Footer Panel */}
      {locals && Object.keys(locals).length > 0 && (
        <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 shadow-md">
          <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">
            Stack Frame Locals
          </h4>
          <div className="flex flex-wrap gap-2.5">
            {Object.entries(locals).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 font-mono text-xs"
              >
                <span className="text-slate-400">{k}:</span>
                <span className="text-emerald-400 font-bold">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
