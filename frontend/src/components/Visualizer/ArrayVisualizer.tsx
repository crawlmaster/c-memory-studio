/**
 * frontend/src/components/Visualizer/ArrayVisualizer.tsx
 * Renders 1D contiguous C arrays (`int arr[N]`, dynamic `int *v`) with:
 * - Distinct badges for `middle`, `mid`, `low`, `high`, `pivot`, `i`, `j`, `k`, and arbitrary index vars
 * - Prominent Target/Key value banner & matching element highlight (for Binary/Linear Search)
 * - Full Stack Locals inspector bar below the array
 */

import React from "react";
import { type ArrayData } from "../../types/debug";
import { BarChart3, Crosshair } from "lucide-react";

export interface ArrayVisualizerProps {
  arrays: ArrayData[];
  locals?: Record<string, number | string>;
}

const POINTER_BADGE_PALETTE: Record<string, string> = {
  i: "bg-sky-500 text-slate-950 border-sky-300",
  j: "bg-amber-500 text-slate-950 border-amber-300",
  k: "bg-purple-500 text-white border-purple-300",
  middle: "bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_10px_rgba(217,70,239,0.5)]",
  mid: "bg-fuchsia-500 text-white border-fuchsia-300 shadow-[0_0_10px_rgba(217,70,239,0.5)]",
  low: "bg-cyan-400 text-slate-950 border-cyan-200",
  left: "bg-cyan-400 text-slate-950 border-cyan-200",
  l: "bg-cyan-400 text-slate-950 border-cyan-200",
  start: "bg-cyan-400 text-slate-950 border-cyan-200",
  high: "bg-orange-500 text-slate-950 border-orange-300",
  right: "bg-orange-500 text-slate-950 border-orange-300",
  r: "bg-orange-500 text-slate-950 border-orange-300",
  end: "bg-orange-500 text-slate-950 border-orange-300",
  pivot: "bg-rose-500 text-white border-rose-300",
  min_idx: "bg-emerald-500 text-slate-950 border-emerald-300",
  max_idx: "bg-indigo-500 text-white border-indigo-300",
};

const FALLBACK_PALETTE = [
  "bg-teal-400 text-slate-950 border-teal-200",
  "bg-pink-500 text-white border-pink-300",
  "bg-lime-400 text-slate-950 border-lime-200",
  "bg-violet-500 text-white border-violet-300",
];

const SEARCH_KEY_NAMES = new Set([
  "target",
  "key",
  "search",
  "val",
  "value",
  "x",
  "elem",
  "needle",
]);

function getBadgeStyle(pointerName: string): string {
  const key = pointerName.toLowerCase();
  if (POINTER_BADGE_PALETTE[key]) {
    return POINTER_BADGE_PALETTE[key];
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

export const ArrayVisualizer: React.FC<ArrayVisualizerProps> = ({
  arrays,
  locals,
}) => {
  // Identify search key variables (like `target = 42`) in locals
  const searchKeyEntries = Object.entries(locals || {}).filter(([k, v]) => {
    const low = k.toLowerCase();
    return (
      SEARCH_KEY_NAMES.has(low) &&
      (typeof v === "number" ||
        (typeof v === "string" && !v.startsWith("0x")))
    );
  });

  if (!arrays || arrays.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
        <BarChart3 className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
        <p className="text-sm font-medium text-slate-300">
          No Contiguous Arrays in Current Scope
        </p>
        <p className="text-xs text-slate-500 max-w-md mt-1">
          Start a GDB trace or step into a function containing stack arrays (e.g.{" "}
          <code className="text-sky-400">int arr[N]</code>) or heap buffers paired
          with a length variable (<code className="text-sky-400">int *v, int n</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-5 overflow-y-auto h-full bg-slate-950">
      {arrays.map((arr) => {
        const numericValues = arr.elements.map((el) => {
          const parsed = typeof el === "number" ? el : Number(el);
          return Number.isFinite(parsed) ? parsed : 0;
        });

        const maxVal = Math.max(...numericValues.map((v) => Math.abs(v)), 1);

        // Map each valid in-bounds array index [0, length - 1] -> list of active pointer names
        const indexToPointers: Record<number, string[]> = {};
        if (arr.active_indices) {
          Object.entries(arr.active_indices).forEach(([ptrName, idxVal]) => {
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
        }

        return (
          <div
            key={arr.name}
            className="rounded-xl bg-slate-900/90 border border-slate-800 p-5 shadow-lg"
          >
            {/* Array Header & Active Index / Target Badges */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-5">
              <div className="flex items-center gap-2.5">
                <span className="px-2.5 py-1 rounded-md bg-sky-500/10 border border-sky-500/30 text-sky-400 font-mono text-xs font-semibold">
                  {arr.type || "int"}[]
                </span>
                <h3 className="text-base font-mono font-bold text-slate-100">
                  {arr.name}
                </h3>
                <span className="text-xs text-slate-400 font-mono">
                  ({arr.elements.length} elements)
                </span>
              </div>

              {/* Search Target Pill + Active Index Legend */}
              <div className="flex flex-wrap items-center gap-2">
                {searchKeyEntries.map(([kName, kVal]) => (
                  <span
                    key={kName}
                    className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400 text-emerald-300 text-xs font-mono font-bold shadow-sm"
                  >
                    <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
                    <span>
                      {kName} = {String(kVal)}
                    </span>
                  </span>
                ))}

                {Object.entries(arr.active_indices || {}).map(
                  ([ptrName, idxVal]) => {
                    const isOutOfBounds =
                      idxVal < 0 || idxVal >= arr.elements.length;
                    return (
                      <span
                        key={ptrName}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${getBadgeStyle(
                          ptrName
                        )} ${isOutOfBounds ? "opacity-60 line-through" : ""}`}
                        title={
                          isOutOfBounds
                            ? `Index ${idxVal} is outside [0, ${
                                arr.elements.length - 1
                              }]`
                            : `Pointing to ${arr.name}[${idxVal}]`
                        }
                      >
                        {ptrName} = {idxVal}
                        {isOutOfBounds ? " (OOB)" : ""}
                      </span>
                    );
                  }
                )}
              </div>
            </div>

            {/* Bars + Value Cards Strip */}
            <div className="overflow-x-auto pb-2">
              <div className="inline-flex items-end gap-3 min-w-full pt-12 pb-2 px-2">
                {arr.elements.map((rawVal, idx) => {
                  const numVal = numericValues[idx];
                  const heightPct = Math.max(
                    12,
                    Math.round((Math.abs(numVal) / maxVal) * 100)
                  );
                  const activePtrs = indexToPointers[idx] || [];
                  const isHighlighted = activePtrs.length > 0;
                  const isMiddleActive = activePtrs.some((p) =>
                    ["middle", "mid", "pivot"].includes(p.toLowerCase())
                  );
                  const matchesSearchTarget = searchKeyEntries.some(
                    ([, kVal]) => Number(kVal) === numVal
                  );

                  return (
                    <div
                      key={`${arr.name}-idx-${idx}`}
                      className="flex flex-col items-center group min-w-[58px]"
                    >
                      {/* Active Index Pointer Badges Floating Above Bar */}
                      <div className="min-h-[32px] flex flex-col items-center justify-end gap-1 mb-1.5">
                        {activePtrs.map((ptr) => (
                          <div
                            key={ptr}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-extrabold border shadow-sm transition-all duration-200 whitespace-nowrap ${getBadgeStyle(
                              ptr
                            )}`}
                          >
                            {ptr} ↓
                          </div>
                        ))}
                      </div>

                      {/* Vertical Magnitude Bar Container */}
                      <div
                        className={`h-36 w-12 bg-slate-950/80 rounded-t-lg border border-b-0 flex items-end p-1 overflow-hidden transition-colors ${
                          matchesSearchTarget
                            ? "border-emerald-500/70"
                            : "border-slate-800/90"
                        }`}
                      >
                        <div
                          style={{ height: `${heightPct}%` }}
                          className={`w-full rounded-t transition-all duration-300 ease-out ${
                            isMiddleActive
                              ? "bg-gradient-to-t from-fuchsia-600 to-fuchsia-400 shadow-[0_0_14px_rgba(217,70,239,0.55)]"
                              : isHighlighted
                              ? "bg-gradient-to-t from-sky-600 to-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]"
                              : matchesSearchTarget
                              ? "bg-gradient-to-t from-emerald-700 to-emerald-500"
                              : "bg-gradient-to-t from-slate-700 to-slate-500"
                          }`}
                        />
                      </div>

                      {/* Numerical Value Card */}
                      <div
                        className={`w-full py-2 px-2 text-center font-mono text-sm font-bold border transition-all duration-300 ${
                          isMiddleActive
                            ? "bg-fuchsia-950 border-fuchsia-400 text-fuchsia-100 shadow-md scale-105 z-10"
                            : isHighlighted
                            ? "bg-sky-950 border-sky-400 text-sky-200 shadow-md scale-105 z-10"
                            : matchesSearchTarget
                            ? "bg-emerald-950/80 border-emerald-500/80 text-emerald-200"
                            : "bg-slate-950 border-slate-800 text-slate-200"
                        }`}
                      >
                        {String(rawVal)}
                      </div>

                      {/* Array Index Footer `[idx]` */}
                      <div
                        className={`mt-1.5 text-[11px] font-mono ${
                          isMiddleActive
                            ? "text-fuchsia-400 font-bold"
                            : isHighlighted
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

      {/* Scalar Stack Locals Bar */}
      {locals && Object.keys(locals).length > 0 && (
        <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 shadow-md">
          <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">
            Stack Frame Local Variables (Scalars, Search Keys &amp; Pointers)
          </h4>
          <div className="flex flex-wrap gap-2.5">
            {Object.entries(locals).map(([k, v]) => {
              const isSearchKey = SEARCH_KEY_NAMES.has(k.toLowerCase());
              return (
                <div
                  key={k}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-mono text-xs ${
                    isSearchKey
                      ? "bg-emerald-950/70 border-emerald-500/70 text-emerald-200 shadow-sm"
                      : "bg-slate-950 border-slate-800 text-slate-200"
                  }`}
                >
                  <span
                    className={
                      isSearchKey
                        ? "text-emerald-400 font-bold"
                        : "text-slate-400"
                    }
                  >
                    {k}:
                  </span>
                  <span className="text-emerald-400 font-bold">{String(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
