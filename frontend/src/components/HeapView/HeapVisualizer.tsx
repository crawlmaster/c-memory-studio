/**
 * frontend/src/components/HeapView/HeapVisualizer.tsx
 * Academic slide-style Valgrind Heap Memory Block Visualizer.
 * - Top summary bar: Total Allocated, Total Freed, Total Leaked, Fatal Error alert badge
 * - Proportional sequential memory block strip:
 *   * Renders a full 100% Emerald Green strip when `blocks` is empty and `total_allocated_bytes == total_freed_bytes > 0`
 *   * Renders a clear "Stack-Only Execution (0 Heap Bytes)" state if no heap allocations occurred
 * - Color-coded states for leaks and invalid accesses with click-to-jump in Monaco
 */

import React from "react";
import {
  type ValgrindAuditResponse,
  type MemoryBlock,
  type HighlightTarget,
} from "../../types/debug";
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Flame,
  ArrowUpRight,
  Cpu,
  Layers,
  CheckCircle2,
} from "lucide-react";

export interface HeapVisualizerProps {
  valgrindData: ValgrindAuditResponse | null;
  isAuditing: boolean;
  onRunAudit: () => void;
  onSelectLine: (target: HighlightTarget) => void;
}

const DIAGONAL_RED_STRIPE_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgba(239, 68, 68, 0.25) 0px, rgba(239, 68, 68, 0.25) 10px, rgba(127, 29, 29, 0.45) 10px, rgba(127, 29, 29, 0.45) 20px)",
};

export const HeapVisualizer: React.FC<HeapVisualizerProps> = ({
  valgrindData,
  isAuditing,
  onRunAudit,
  onSelectLine,
}) => {
  if (isAuditing) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-slate-300 p-8">
        <div className="w-10 h-10 border-3 border-amber-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-mono font-semibold">
          Executing Valgrind Memcheck (--leak-check=full --xtree-memory=full)...
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Inspecting synthetic CPU shadow memory and heap allocation ledger
        </p>
      </div>
    );
  }

  if (!valgrindData || !valgrindData.summary) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-slate-400 p-8 text-center">
        <Layers className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
        <p className="text-sm font-medium text-slate-200">
          No Valgrind Heap Audit Executed Yet
        </p>
        <p className="text-xs text-slate-500 max-w-md mt-1 mb-5">
          Run the automated Valgrind Memcheck auditor to inspect physical heap
          allocations, definitely lost blocks, and out-of-bounds memory accesses.
        </p>
        <button
          type="button"
          onClick={onRunAudit}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs transition shadow-md cursor-pointer"
        >
          <ShieldAlert className="w-4 h-4" />
          <span>Run Valgrind Audit Now</span>
        </button>
      </div>
    );
  }

  const { summary, blocks = [] } = valgrindData;
  const freedBytes = Math.max(0, summary.total_freed_bytes);
  const totalArenaBytes = Math.max(
    summary.total_allocated_bytes,
    freedBytes + summary.leaked_bytes,
    1
  );

  const isCompletelyCleanWithHeapUsage =
    blocks.length === 0 &&
    !summary.has_fatal_errors &&
    summary.total_allocated_bytes > 0 &&
    freedBytes > 0;

  const isZeroHeapUsage =
    blocks.length === 0 &&
    summary.total_allocated_bytes === 0 &&
    freedBytes === 0;

  const handleBlockClick = (block: MemoryBlock, preferDetected: boolean = false) => {
    const targetLoc =
      preferDetected && block.detected_at?.line
        ? block.detected_at
        : block.allocated_at || block.detected_at;

    if (targetLoc && targetLoc.line > 0) {
      onSelectLine({
        line: targetLoc.line,
        type:
          block.state === "INVALID_ACCESS" ||
          block.state === "INVALID_FREE" ||
          block.state === "DEFINITELY_LOST"
            ? "error"
            : "warning",
        message: `${block.state}: ${block.description}`,
        timestamp: Date.now(),
      });
    }
  };

  return (
    <div className="flex flex-col gap-6 p-5 h-full overflow-y-auto bg-slate-950">
      {/* 1. Top Summary Metrics Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-3.5">
          <div className="text-[11px] font-mono uppercase text-slate-400">
            Total Allocated
          </div>
          <div className="text-xl font-mono font-bold text-slate-100 mt-1">
            {summary.total_allocated_bytes.toLocaleString()}{" "}
            <span className="text-xs font-normal text-slate-400">bytes</span>
          </div>
        </div>

        <div className="rounded-xl bg-emerald-950/30 border border-emerald-800/50 p-3.5">
          <div className="text-[11px] font-mono uppercase text-emerald-400">
            Total Freed (Clean)
          </div>
          <div className="text-xl font-mono font-bold text-emerald-300 mt-1">
            {freedBytes.toLocaleString()}{" "}
            <span className="text-xs font-normal text-emerald-400/80">bytes</span>
          </div>
        </div>

        <div
          className={`rounded-xl p-3.5 border ${
            summary.leaked_bytes > 0
              ? "bg-rose-950/40 border-rose-700/70"
              : "bg-slate-900 border-slate-800"
          }`}
        >
          <div className="text-[11px] font-mono uppercase text-rose-400">
            Total Leaked
          </div>
          <div className="text-xl font-mono font-bold text-rose-300 mt-1">
            {summary.leaked_bytes.toLocaleString()}{" "}
            <span className="text-xs font-normal text-rose-400/80">
              bytes ({summary.leak_count} blocks)
            </span>
          </div>
        </div>

        <div
          className={`rounded-xl p-3.5 border flex flex-col justify-between ${
            summary.has_fatal_errors
              ? "bg-red-950/60 border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.2)]"
              : "bg-emerald-950/30 border-emerald-700/50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-slate-300">
              Auditor Verdict
            </span>
            {summary.has_fatal_errors ? (
              <Flame className="w-4 h-4 text-red-400 animate-pulse" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            {summary.has_fatal_errors ? (
              <span className="px-2 py-0.5 rounded bg-red-500 text-white font-mono text-xs font-extrabold tracking-wide">
                FATAL MEMORY ERROR
              </span>
            ) : summary.leaked_bytes > 0 ? (
              <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-mono text-xs font-bold">
                LEAKS DETECTED
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-mono text-xs font-bold">
                HEAP CLEAN
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Academic Slide-Style Proportional Physical Heap Strip */}
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-mono font-bold text-slate-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-amber-400" />
              <span>Physical Heap Arena Layout (Proportional Block Strip)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Click any block in the strip to jump directly to its allocation or
              fault line in the C editor.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-400">
            Arena Span: {summary.total_allocated_bytes.toLocaleString()} B
          </span>
        </div>

        {/* Sequential Proportional Strip */}
        <div className="w-full min-h-[82px] rounded-lg bg-slate-950 border border-slate-800 p-1.5 flex items-stretch gap-1.5 overflow-x-auto">
          {isZeroHeapUsage ? (
            <div className="w-full rounded-md bg-slate-900/70 border border-slate-800 p-3 flex items-center justify-center text-xs font-mono text-slate-400">
              0 Heap Bytes Allocated (Stack-Only Execution)
            </div>
          ) : isCompletelyCleanWithHeapUsage ? (
            <div className="w-full rounded-md bg-gradient-to-r from-emerald-950/90 via-emerald-900/60 to-emerald-950/90 border-2 border-emerald-500/80 p-3.5 flex items-center justify-between shadow-[0_0_20px_rgba(16,185,129,0.2)]">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <div className="text-xs font-mono font-extrabold text-emerald-200 tracking-wide">
                    100% FREED / CLEAN HEAP ARENA
                  </div>
                  <div className="text-[11px] font-mono text-emerald-300/85 mt-0.5">
                    All {freedBytes.toLocaleString()} bytes across{" "}
                    {summary.total_alloc_calls || "all"} heap allocation(s) were
                    cleanly reclaimed via free()
                  </div>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded bg-emerald-500 text-slate-950 font-mono text-xs font-extrabold">
                {freedBytes.toLocaleString()} /{" "}
                {summary.total_allocated_bytes.toLocaleString()} B Freed
              </span>
            </div>
          ) : (
            <>
              {freedBytes > 0 && (
                <div
                  style={{
                    flexGrow: Math.max(
                      15,
                      Math.round((freedBytes / totalArenaBytes) * 100)
                    ),
                    minWidth: "145px",
                  }}
                  className="rounded-md bg-emerald-950/70 border border-emerald-600/70 p-2.5 flex flex-col justify-between transition hover:border-emerald-400"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-emerald-300 font-bold">
                      FREED / CLEAN
                    </span>
                    <span className="text-emerald-400">
                      {freedBytes.toLocaleString()} B
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-emerald-200/80 truncate mt-1">
                    Reclaimed via free()
                  </div>
                </div>
              )}

              {blocks.map((block) => {
                const weight = Math.max(
                  15,
                  Math.round(((block.size_bytes || 32) / totalArenaBytes) * 100)
                );

                const isDefLost = block.state === "DEFINITELY_LOST";
                const isInvalid =
                  block.state === "INVALID_ACCESS" ||
                  block.state === "INVALID_FREE" ||
                  block.state === "UNINITIALIZED_READ";

                let borderAndBg =
                  "bg-amber-950/60 border-amber-500/80 text-amber-200";
                if (isDefLost) {
                  borderAndBg = "border-red-500 text-red-100";
                } else if (isInvalid) {
                  borderAndBg =
                    "bg-rose-950/90 border-2 border-rose-500 text-rose-100 shadow-[0_0_15px_rgba(244,63,94,0.35)]";
                }

                return (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => handleBlockClick(block, isInvalid)}
                    style={{
                      flexGrow: weight,
                      minWidth: "155px",
                      ...(isDefLost ? DIAGONAL_RED_STRIPE_STYLE : {}),
                    }}
                    className={`rounded-md border p-2.5 flex flex-col justify-between text-left transition transform hover:-translate-y-0.5 cursor-pointer ${borderAndBg}`}
                  >
                    <div className="flex items-center justify-between gap-1 text-[11px] font-mono w-full">
                      <span className="font-bold truncate">{block.address}</span>
                      <span className="px-1.5 py-0.2 rounded bg-black/40 text-[10px]">
                        {block.size_bytes} B
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-1 mt-2 w-full">
                      <span className="text-[10px] font-mono uppercase tracking-tight font-semibold truncate">
                        {block.state}
                      </span>
                      <span className="text-[10px] font-mono opacity-85 truncate">
                        {block.allocated_at?.function || "main"}()
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-emerald-900 border border-emerald-500 inline-block" />
            <span>Freed / Clean</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              style={DIAGONAL_RED_STRIPE_STYLE}
              className="w-3.5 h-3.5 rounded-sm border border-red-500 inline-block"
            />
            <span>DEFINITELY_LOST (Striped)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-rose-950 border-2 border-rose-500 inline-block" />
            <span>INVALID_ACCESS / CORRUPTION</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-amber-950 border border-amber-500 inline-block" />
            <span>STILL_REACHABLE / POSSIBLY_LOST</span>
          </div>
        </div>
      </div>

      {/* 3. Detailed Valgrind Diagnostic Cards */}
      <div className="space-y-3">
        <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">
          Detailed Block &amp; Access Diagnostics ({blocks.length})
        </h4>

        {blocks.length === 0 ? (
          <div className="rounded-xl bg-emerald-950/20 border border-emerald-800/50 p-4 flex items-center gap-3 text-emerald-300 text-xs font-mono">
            <ShieldCheck className="w-5 h-5 shrink-0 text-emerald-400" />
            <span>
              {summary.total_allocated_bytes > 0
                ? `All ${summary.total_allocated_bytes.toLocaleString()} allocated heap bytes were cleanly freed via free() and no invalid memory operations were detected.`
                : "No heap leaks or invalid memory operations were detected."}
            </span>
          </div>
        ) : (
          blocks.map((block) => {
            const isDefLost = block.state === "DEFINITELY_LOST";
            const isInvalid =
              block.state === "INVALID_ACCESS" ||
              block.state === "INVALID_FREE" ||
              block.state === "UNINITIALIZED_READ";

            return (
              <div
                key={block.id}
                style={isDefLost ? DIAGONAL_RED_STRIPE_STYLE : undefined}
                className={`rounded-xl border p-4 transition ${
                  isInvalid
                    ? "bg-rose-950/40 border-rose-500/80"
                    : isDefLost
                    ? "border-red-500/80 bg-slate-900"
                    : "bg-amber-950/25 border-amber-600/60"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    {isInvalid ? (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    <span className="px-2 py-0.5 rounded bg-black/50 border border-white/15 font-mono text-xs font-bold text-white">
                      {block.state}
                    </span>
                    <span className="font-mono text-xs text-sky-300 font-semibold">
                      {block.address}
                    </span>
                    <span className="text-xs font-mono text-slate-300">
                      ({block.size_bytes} bytes in {block.block_count} block
                      {block.block_count === 1 ? "" : "s"})
                    </span>
                  </div>

                  <span className="text-[11px] font-mono text-slate-400">
                    ID: {block.id}
                  </span>
                </div>

                <p className="text-xs font-mono text-slate-200 mt-2.5 bg-slate-950/70 px-3 py-2 rounded border border-slate-800">
                  {block.description}
                </p>

                <div className="flex flex-wrap items-center gap-3 mt-3">
                  {block.allocated_at && (
                    <button
                      type="button"
                      onClick={() => handleBlockClick(block, false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 text-xs font-mono text-sky-300 transition cursor-pointer"
                    >
                      <span>
                        Allocated at{" "}
                        <strong>{block.allocated_at.function}()</strong> (
                        {block.allocated_at.file}:{block.allocated_at.line})
                      </span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {block.detected_at && (
                    <button
                      type="button"
                      onClick={() => handleBlockClick(block, true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/90 hover:bg-rose-900 border border-rose-500 text-xs font-mono text-rose-200 transition cursor-pointer"
                    >
                      <span>
                        Fault Detected at{" "}
                        <strong>{block.detected_at.function}()</strong> (
                        {block.detected_at.file}:{block.detected_at.line})
                      </span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
