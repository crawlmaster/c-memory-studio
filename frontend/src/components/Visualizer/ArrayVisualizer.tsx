/**
 * frontend/src/components/Visualizer/ArrayVisualizer.tsx
 * Renders 1D contiguous C arrays (`int arr[N]`, dynamic `int *v`) with:
 * - Proportional vertical height bars
 * - Numerical cell cards with index footers
 * - Color-coded active index pointer badges (`i`, `j`, `pivot`, `min_idx`, `low`, `high`)
 */

import React from "react";
import type { ArrayData } from "../../types/debug";
import { BarChart3 } from "lucide-react";

export interface ArrayVisualizerProps {
  arrays: ArrayData[];
  locals?: Record<string, number | string>;
}

const POINTER_BADGE_PALETTE: Record<string, string> = {
  i: "bg-sky-500 text-slate-950 border-sky-300",
  j: "bg-amber-500 text-slate-950 border-amber-300",
  k: "bg-purple-500 text-white border-purple-300",
  pivot: "bg-rose-500 text-white border-rose-300",
  min_idx: "bg-emerald-500 text-slate-950 border-emerald-300",
  max_idx: "bg-fuchsia-500 text-white border-fuchsia-300",
  low: "bg-cyan-500 text-slate-950 border-cyan-300",
  high: "bg-orange-500 text-slate-950 border-orange-300",
  mid: "bg-indigo-500 text-white border-indigo-300",
};

function getBadgeStyle(pointerName: string): string {
  const key = pointerName.toLowerCase();
  return (
    POINTER_BADGE_PALETTE[key] ||
    "bg-teal-500 text-slate-950 border-teal-300"
  );
}

export const ArrayVisualizer: React.FC<ArrayVisualizerProps> = ({
  arrays,
  locals,
}) => {
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
          with a length variable (<code className="text-sky-400">int *arr, int n</code>).
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

        // Map each array index -> list of active pointer names pointing to that index
        const indexToPointers: Record<number, string[]> = {};
        if (arr.active_indices) {
          Object.entries(arr.active_indices).forEach(([ptrName, idxVal]) => {
            if (typeof idxVal === "number") {
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
            {/* Array Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-5">
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

              {/* Active Index Legend */}
              <div className="flex flex-wrap items-center gap-2">
                {Object.entries(arr.active_indices || {}).map(
                  ([ptrName, idxVal]) => (
                    <span
                      key={ptrName}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${getBadgeStyle(
                        ptrName
                      )}`}
                    >
                      {ptrName} = {idxVal}
                    </span>
                  )
                )}
              </div>
            </div>

            {/* Bars + Value Cards Strip */}
            <div className="overflow-x-auto pb-2">
              <div className="inline-flex items-end gap-3 min-w-full pt-10 pb-2 px-2">
                {arr.elements.map((rawVal, idx) => {
                  const numVal = numericValues[idx];
                  const heightPct = Math.max(
                    12,
                    Math.round((Math.abs(numVal) / maxVal) * 100)
                  );
                  const activePtrs = indexToPointers[idx] || [];
                  const isHighlighted = activePtrs.length > 0;

                  return (
                    <div
                      key={`${arr.name}-idx-${idx}`}
                      className="flex flex-col items-center group min-w-[54px]"
                    >
                      {/* Active Index Pointer Badges Floating Above Bar */}
                      <div className="min-h-[28px] flex flex-col items-center justify-end gap-1 mb-1.5">
                        {activePtrs.map((ptr) => (
                          <div
                            key={ptr}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-extrabold border shadow-sm transition-all duration-300 transform -translate-y-0.5 ${getBadgeStyle(
                              ptr
                            )}`}
                          >
                            {ptr} ↓
                          </div>
                        ))}
                      </div>

                      {/* Vertical Magnitude Bar Container */}
                      <div className="h-36 w-11 bg-slate-950/80 rounded-t-lg border border-b-0 border-slate-800/90 flex items-end p-1 overflow-hidden">
                        <div
                          style={{ height: `${heightPct}%` }}
                          className={`w-full rounded-t transition-all duration-300 ease-out ${
                            isHighlighted
                              ? "bg-gradient-to-t from-sky-600 to-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]"
                              : "bg-gradient-to-t from-slate-700 to-slate-500"
                          }`}
                        />
                      </div>

                      {/* Numerical Value Card */}
                      <div
                        className={`w-full py-2 px-2 text-center font-mono text-sm font-bold border transition-all duration-300 ${
                          isHighlighted
                            ? "bg-sky-950 border-sky-400 text-sky-200 shadow-md scale-105 z-10"
                            : "bg-slate-950 border-slate-800 text-slate-200"
                        }`}
                      >
                        {String(rawVal)}
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

      {/* Scalar Stack Locals Footer */}
      {locals && Object.keys(locals).length > 0 && (
        <div className="rounded-xl bg-slate-900/60 border border-slate-800/80 p-4">
          <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">
            Active Stack Frame Locals
          </h4>
          <div className="flex flex-wrap gap-2.5">
            {Object.entries(locals).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs"
              >
                <span className="text-slate-400">{k}:</span>
                <span className="text-emerald-400 font-semibold">
                  {String(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
