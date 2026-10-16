/**
 * frontend/src/components/Visualizer/ArrayVisualizer.tsx
 * Dual-Mode 1D Array / Compound Tuple / 2D Matrix Grid Visualizer.
 *
 * Features:
 * 1. Strict 1D vs 2D Matrix Discrimination:
 *    - Whenever `arr.kind === "matrix"` or `arr.dimensions?.length === 2` (or 2D nested rows),
 *      bypasses the 1D bar-chart renderer and renders `<MatrixGrid />`.
 * 2. Dedicated `<MatrixGrid />` Component:
 *    - Header bar with matrix C declaration (`int mat[10][10]`), dimension badge (`10 × 10`),
 *      and active loop index pills (`i = 3`, `j = 1`).
 *    - Dark-themed HTML table grid with sticky `[0]..[C-1]` column headers and `[0]..[R-1]` row headers.
 *    - Crosshair row/column shading + glowing target cell highlight when active indices match `[r][c]`.
 *    - Step-delta mutation tracking: flashes cells that were just written/updated on the current step.
 *    - Muted styling (`text-slate-600`) for `0` or uninitialized stack garbage values.
 */

import React, { useRef, useEffect } from "react";
import {
  type ArraySnapshot,
  type ArrayElement,
  type CompoundArrayElement,
  type GraphNode,
} from "../../types/debugger";
import { BarChart3, Database, Grid3X3, Layers } from "lucide-react";

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
    !Array.isArray(el) &&
    "fields" in el &&
    el.fields !== null &&
    typeof el.fields === "object"
  );
}

/**
 * Strictly discriminates whether an ArraySnapshot represents a 2D Matrix
 * rather than a 1D Array.
 */
function isMatrixSnapshot(arr: ArraySnapshot): boolean {
  if (arr.kind === "matrix") return true;
  if (Array.isArray(arr.dimensions) && arr.dimensions.length === 2) return true;
  if (Array.isArray(arr.rows) && arr.rows.length > 0) return true;
  if (
    Array.isArray(arr.elements) &&
    arr.elements.length > 0 &&
    Array.isArray(arr.elements[0])
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts normalized 2D rows `Array<Array<number | string>>` and `[numRows, numCols]`
 * from a matrix snapshot.
 */
function extractMatrixGridData(arr: ArraySnapshot): {
  gridRows: Array<Array<number | string>>;
  numRows: number;
  numCols: number;
} {
  const rawRows: Array<Array<number | string>> = Array.isArray(arr.rows)
    ? arr.rows
    : Array.isArray(arr.elements) && Array.isArray(arr.elements[0])
    ? (arr.elements as unknown as Array<Array<number | string>>)
    : [];

  const numRows =
    arr.dimensions && arr.dimensions.length >= 1
      ? arr.dimensions[0]
      : rawRows.length;
  const numCols =
    arr.dimensions && arr.dimensions.length >= 2
      ? arr.dimensions[1]
      : rawRows[0]?.length || 0;

  return {
    gridRows: rawRows,
    numRows,
    numCols,
  };
}

/**
 * Heuristic-free check for uninitialized stack garbage values (e.g. -135296, 32767, 0x7fff...)
 * vs meaningful matrix numbers so uninitialized cells in stack matrices (`int mat[10][10]`)
 * render with subtle muted text until written.
 */
function isLikelyGarbageOrZero(val: number | string): {
  isZero: boolean;
  isGarbage: boolean;
  displayVal: string;
} {
  if (typeof val === "number") {
    if (val === 0) {
      return { isZero: true, isGarbage: false, displayVal: "0" };
    }
    if (Math.abs(val) >= 32760) {
      return { isZero: false, isGarbage: true, displayVal: String(val) };
    }
    return { isZero: false, isGarbage: false, displayVal: String(val) };
  }

  const str = String(val).trim();
  if (str === "0") {
    return { isZero: true, isGarbage: false, displayVal: "0" };
  }
  if (str === "∞") {
    return { isZero: false, isGarbage: false, displayVal: "∞" };
  }
  const num = Number(str);
  if (Number.isFinite(num) && Math.abs(num) >= 32760) {
    return { isZero: false, isGarbage: true, displayVal: str };
  }
  return { isZero: false, isGarbage: false, displayVal: str };
}

interface MatrixGridProps {
  matrix: ArraySnapshot;
}

/**
 * Dedicated 2D Matrix Table / Grid Component.
 */
const MatrixGrid: React.FC<MatrixGridProps> = ({ matrix }) => {
  const { gridRows, numRows, numCols } = extractMatrixGridData(matrix);
  const prevGridRef = useRef<Record<string, string>>({});

  const activeEntries = Object.entries(matrix.active_indices || {});

  // Identify active row and column indices from syntactically proven active_indices:
  // If 2+ active indices exist (e.g. outer loop `i` and inner loop `j`), the 1st maps to row and 2nd to col.
  // If 1 active index exists, highlight that row index.
  const rowCursor = activeEntries.length >= 1 ? activeEntries[0] : null;
  const colCursor = activeEntries.length >= 2 ? activeEntries[1] : null;

  const activeRowIdx =
    rowCursor && rowCursor[1] >= 0 && rowCursor[1] < numRows
      ? rowCursor[1]
      : null;
  const activeColIdx =
    colCursor && colCursor[1] >= 0 && colCursor[1] < numCols
      ? colCursor[1]
      : null;

  // Detect cells modified on the current step compared to the previous render
  const modifiedCells = new Set<string>();
  const currentSnapshotMap: Record<string, string> = {};

  gridRows.forEach((rList, rIdx) => {
    rList.forEach((cellVal, cIdx) => {
      const key = `${rIdx}:${cIdx}`;
      const strVal = String(cellVal);
      currentSnapshotMap[key] = strVal;
      if (
        prevGridRef.current[key] !== undefined &&
        prevGridRef.current[key] !== strVal
      ) {
        modifiedCells.add(key);
      }
    });
  });

  useEffect(() => {
    prevGridRef.current = currentSnapshotMap;
  });

  const baseType = (matrix.element_type || matrix.type || "int")
    .replace(/\[.*$/, "")
    .trim();

  return (
    <div className="rounded-xl bg-slate-900/95 border border-slate-800 p-5 shadow-lg">
      {/* 1. Matrix Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5 mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 font-mono text-xs font-semibold">
            <Grid3X3 className="w-3.5 h-3.5 text-indigo-400" />
            <span>
              {baseType} {matrix.name}[{numRows}][{numCols}]
            </span>
          </span>

          <span className="px-2.5 py-0.5 rounded-full bg-slate-950 border border-slate-800 text-xs font-mono font-bold text-sky-400">
            {numRows} &times; {numCols}
          </span>
        </div>

        {/* Active Loop Index Badges */}
        <div className="flex flex-wrap items-center gap-2">
          {activeRowIdx !== null && activeColIdx !== null && (
            <span className="px-2.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/70 text-amber-300 text-xs font-mono font-bold shadow-sm">
              Target: {matrix.name}[{activeRowIdx}][{activeColIdx}]
            </span>
          )}

          {activeEntries.map(([ptrName, idxVal], idxPos) => {
            const boundLimit = idxPos === 0 ? numRows : numCols;
            const isOob = idxVal < 0 || idxVal >= boundLimit;
            const axisRole =
              activeEntries.length >= 2
                ? idxPos === 0
                  ? "row"
                  : idxPos === 1
                  ? "col"
                  : ""
                : "row";

            return (
              <span
                key={ptrName}
                className={`px-2.5 py-0.5 rounded text-[11px] font-mono font-bold border ${getIndexBadgeStyle(
                  ptrName
                )} ${isOob ? "opacity-65" : ""}`}
              >
                {ptrName} = {idxVal}
                {axisRole ? ` (${axisRole})` : ""}
              </span>
            );
          })}
        </div>
      </div>

      {/* 2. Scrollable 2D Matrix Table Container */}
      <div className="max-h-[500px] overflow-auto border border-slate-800 rounded-lg p-4 bg-slate-950/60">
        <table className="border-separate border-spacing-1.5 font-mono text-xs mx-auto">
          <thead>
            <tr>
              {/* Top-Left Corner Axis Key */}
              <th className="sticky top-0 left-0 z-20 bg-slate-900/95 border border-slate-800 rounded-md px-2.5 py-1.5 text-[10px] text-slate-400 font-semibold">
                [r \ c]
              </th>

              {/* Column Headers [0], [1], ... */}
              {Array.from({ length: numCols }).map((_, cIdx) => {
                const isColActive = activeColIdx === cIdx;
                return (
                  <th
                    key={`col-hdr-${cIdx}`}
                    className={`sticky top-0 z-10 min-w-[48px] px-2 py-1.5 rounded-md border text-center transition-colors ${
                      isColActive
                        ? "bg-amber-950/90 border-amber-400 text-amber-300 font-extrabold shadow-[0_0_10px_rgba(251,191,36,0.3)]"
                        : "bg-slate-900/90 border-slate-800/90 text-slate-400 font-medium"
                    }`}
                  >
                    <div className="flex flex-col items-center leading-tight">
                      {isColActive && colCursor && (
                        <span className="text-[9px] text-amber-400 font-extrabold mb-0.5">
                          {colCursor[0]} ↓
                        </span>
                      )}
                      <span>[{cIdx}]</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {gridRows.map((rowValues, rIdx) => {
              const isRowActive = activeRowIdx === rIdx;

              return (
                <tr key={`row-${rIdx}`}>
                  {/* Sticky Row Header [0], [1], ... */}
                  <th
                    className={`sticky left-0 z-10 min-w-[48px] px-2.5 py-1.5 rounded-md border text-center transition-colors ${
                      isRowActive
                        ? "bg-sky-950/90 border-sky-400 text-sky-300 font-extrabold shadow-[0_0_10px_rgba(56,189,248,0.3)]"
                        : "bg-slate-900/90 border-slate-800/90 text-slate-400 font-medium"
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1">
                      {isRowActive && rowCursor && (
                        <span className="text-[9px] text-sky-400 font-extrabold">
                          {rowCursor[0]} →
                        </span>
                      )}
                      <span>[{rIdx}]</span>
                    </div>
                  </th>

                  {/* Matrix Cells */}
                  {Array.from({ length: numCols }).map((_, cIdx) => {
                    const rawCellVal =
                      cIdx < rowValues.length ? rowValues[cIdx] : 0;
                    const { isZero, isGarbage, displayVal } =
                      isLikelyGarbageOrZero(rawCellVal);

                    const isTargetCell =
                      activeRowIdx === rIdx && activeColIdx === cIdx;
                    const isJustModified = modifiedCells.has(
                      `${rIdx}:${cIdx}`
                    );
                    const isCrosshair =
                      !isTargetCell &&
                      (activeRowIdx === rIdx || activeColIdx === cIdx);

                    let cellClasses =
                      "bg-slate-900/90 border-slate-800 text-slate-100";
                    if (isTargetCell) {
                      cellClasses =
                        "bg-amber-950/90 border-2 border-amber-400 text-amber-100 font-extrabold scale-105 z-10 shadow-[0_0_14px_rgba(251,191,36,0.5)]";
                    } else if (isJustModified) {
                      cellClasses =
                        "bg-emerald-950/85 border-2 border-emerald-400 text-emerald-200 font-extrabold shadow-[0_0_12px_rgba(52,211,153,0.4)]";
                    } else if (isCrosshair) {
                      cellClasses = isGarbage || isZero
                        ? "bg-slate-900/95 border-sky-500/40 text-slate-500"
                        : "bg-sky-950/40 border-sky-500/50 text-sky-100 font-semibold";
                    } else if (isGarbage || isZero) {
                      cellClasses =
                        "bg-slate-950/80 border-slate-800/70 text-slate-600";
                    } else {
                      cellClasses =
                        "bg-slate-900 border-slate-700/80 text-emerald-300 font-bold";
                    }

                    return (
                      <td
                        key={`cell-${rIdx}-${cIdx}`}
                        title={
                          isGarbage
                            ? `${matrix.name}[${rIdx}][${cIdx}] = ${displayVal} (uninitialized stack memory)`
                            : `${matrix.name}[${rIdx}][${cIdx}] = ${displayVal}`
                        }
                        className={`w-12 h-10 px-2 py-1.5 rounded-md border text-center align-middle transition-all duration-200 select-all ${cellClasses}`}
                      >
                        <div className="truncate max-w-[54px] mx-auto">
                          {isGarbage ? "·" : displayVal}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Matrix Legend Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-2.5 border-t border-slate-800/70 text-[11px] font-mono text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-amber-950 border-2 border-amber-400 inline-block" />
            <span>Active Target [i][j]</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-emerald-950 border-2 border-emerald-400 inline-block" />
            <span>Updated This Step</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-slate-950 border border-slate-800 inline-block" />
            <span className="text-slate-500">0 / Unwritten (·)</span>
          </div>
        </div>
        <span className="text-slate-500">
          Hover any cell to inspect exact value &amp; coordinates
        </span>
      </div>
    </div>
  );
};

interface NormalizedCell {
  isCompound: boolean;
  fields: Array<[string, number | string]>;
  scalarText: string;
  barMetric: number;
  isInfinity: boolean;
}

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

  if (
    el !== null &&
    typeof el === "object" &&
    !Array.isArray(el) &&
    "value" in (el as Record<string, unknown>)
  ) {
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
          No Contiguous Arrays or 2D Matrices in Current Scope
        </p>
        <p className="text-xs text-slate-500 max-w-md mt-1">
          Start a GDB trace or step into a function containing 1D arrays, 2D
          matrices (<code className="text-indigo-400">int mat[R][C]</code>), or
          struct-embedded buffers to inspect live elements.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-5 overflow-y-auto h-full bg-slate-950">
      {arrays.map((arr) => {
        // Strict discrimination: 2D matrices bypass the 1D bar-chart view completely
        if (isMatrixSnapshot(arr)) {
          return <MatrixGrid key={arr.name} matrix={arr} />;
        }

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
            {/* 1D Array Header */}
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

            {/* 1D Bars + Element Cards Strip */}
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

                      {/* Element Card */}
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
