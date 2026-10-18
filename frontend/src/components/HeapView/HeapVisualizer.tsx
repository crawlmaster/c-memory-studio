/**
 * frontend/src/components/Visualizer/HeapVisualizer.tsx
 * Null-Safe Valgrind Memcheck, Heap Allocation Balance & Leak Stack-Trace Visualizer.
 *
 * Key Guarantees:
 * 1. Never Returns `null`:
 *    - Renders clear, visible states for Loading (`isLoading` / `isAuditing`),
 *      Error (`error` / `compile_error`), Empty State (`!resolvedData`), and
 *      Full Audit Report (KPI cards, Leak Summary breakdown, Stack Traces, stdout, Raw Log).
 * 2. Universal Prop & Envelope Unwrapping:
 *    - Accepts `data`, `report`, `audit`, `valgrind`, `result`, `analysis`, `valgrindData`,
 *      or `auditData`, and unwraps nested `{ audit: ... }` / `{ data: ... }` envelopes.
 * 3. Safe Numerical Formatting:
 *    - Every metric is sanitized through `safeNum(val, 0)` and `(val ?? 0).toLocaleString()`
 *      so undefined fields can never throw a TypeError.
 */

import React, { Component, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Terminal,
  Layers,
  Cpu,
  FileWarning,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Activity,
  Play,
} from "lucide-react";

export interface ValgrindStackFrame {
  ip?: string;
  fn?: string;
  func?: string;
  function?: string;
  file?: string;
  line?: number;
  is_user_code?: boolean;
}

export interface ValgrindDiagnosticItem {
  id?: string;
  kind?: string;
  type?: string;
  what?: string;
  message?: string;
  description?: string;
  bytes_leaked?: number;
  blocks_leaked?: number;
  file?: string;
  line?: number;
  function?: string;
  auxwhat?: string[];
  stack?: ValgrindStackFrame[];
  frames?: ValgrindStackFrame[];
}

export interface HeapVisualizerProps {
  data?: Record<string, unknown> | null;
  report?: Record<string, unknown> | null;
  audit?: Record<string, unknown> | null;
  valgrind?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  valgrindData?: Record<string, unknown> | null;
  auditData?: Record<string, unknown> | null;
  isLoading?: boolean;
  isAnalyzing?: boolean;
  isAuditing?: boolean;
  error?: string | null;
  onJumpToLine?: (line: number) => void;
  onSelectLine?: (line: number) => void;
  onRunAudit?: () => void;
}

function safeNum(val: unknown, fallback: number = 0): number {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string") {
    const cleaned = val.replace(/,/g, "").trim();
    if (cleaned !== "") {
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function formatNum(val: unknown): string {
  return safeNum(val, 0).toLocaleString();
}

function asRecord(val: unknown): Record<string, unknown> {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

interface NormalizedAuditData {
  status: string;
  isClean: boolean;
  compileError: string | null;
  stdout: string;
  stderr: string;
  rawLog: string;
  totalAllocs: number;
  totalFrees: number;
  totalBytesAllocated: number;
  inUseAtExitBytes: number;
  inUseAtExitBlocks: number;
  definitelyLostBytes: number;
  definitelyLostBlocks: number;
  indirectlyLostBytes: number;
  indirectlyLostBlocks: number;
  possiblyLostBytes: number;
  possiblyLostBlocks: number;
  stillReachableBytes: number;
  stillReachableBlocks: number;
  suppressedBytes: number;
  suppressedBlocks: number;
  errorCount: number;
  diagnostics: ValgrindDiagnosticItem[];
}

function normalizeValgrindPayload(
  incoming: Record<string, unknown>
): NormalizedAuditData {
  // Unwrap nested envelopes (`data.audit ?? data.data ?? data.result ?? data`)
  const unwrapped =
    incoming.audit && typeof incoming.audit === "object"
      ? asRecord(incoming.audit)
      : incoming.data && typeof incoming.data === "object"
      ? asRecord(incoming.data)
      : incoming.result && typeof incoming.result === "object"
      ? asRecord(incoming.result)
      : incoming;

  const summary = asRecord(unwrapped.summary);
  const heapSummary = asRecord(unwrapped.heap_summary);
  const leakSummary = asRecord(unwrapped.leak_summary);

  const status = String(unwrapped.status ?? "completed");
  const compileError =
    typeof unwrapped.compile_error === "string" &&
    unwrapped.compile_error.trim() !== ""
      ? unwrapped.compile_error
      : status === "compile_error" && typeof unwrapped.stderr === "string"
      ? unwrapped.stderr
      : status === "compile_error" && typeof unwrapped.detail === "string"
      ? unwrapped.detail
      : null;

  const totalAllocs = safeNum(
    summary.total_allocs ??
      heapSummary.total_allocs ??
      unwrapped.total_allocs ??
      summary.allocs ??
      unwrapped.allocs,
    0
  );

  const totalFrees = safeNum(
    summary.total_frees ??
      heapSummary.total_frees ??
      unwrapped.total_frees ??
      summary.frees ??
      unwrapped.frees,
    0
  );

  const totalBytesAllocated = safeNum(
    summary.bytes_allocated ??
      summary.total_bytes_allocated ??
      summary.total_bytes ??
      heapSummary.total_bytes_allocated ??
      heapSummary.bytes_allocated ??
      unwrapped.bytes_allocated ??
      unwrapped.total_bytes_allocated ??
      unwrapped.total_bytes,
    0
  );

  const inUseAtExitBytes = safeNum(
    summary.in_use_at_exit_bytes ??
      summary.in_use_bytes ??
      heapSummary.in_use_at_exit_bytes ??
      unwrapped.in_use_at_exit_bytes ??
      unwrapped.in_use_bytes,
    0
  );

  const inUseAtExitBlocks = safeNum(
    summary.in_use_at_exit_blocks ??
      summary.in_use_blocks ??
      heapSummary.in_use_at_exit_blocks ??
      unwrapped.in_use_at_exit_blocks ??
      unwrapped.in_use_blocks,
    0
  );

  const definitelyLostBytes = safeNum(
    summary.definitely_lost_bytes ??
      summary.definitely_lost ??
      leakSummary.definitely_lost_bytes ??
      leakSummary.definitely_lost ??
      unwrapped.definitely_lost_bytes ??
      unwrapped.definitely_lost,
    0
  );

  const definitelyLostBlocks = safeNum(
    summary.definitely_lost_blocks ??
      leakSummary.definitely_lost_blocks ??
      unwrapped.definitely_lost_blocks,
    0
  );

  const indirectlyLostBytes = safeNum(
    summary.indirectly_lost_bytes ??
      summary.indirectly_lost ??
      leakSummary.indirectly_lost_bytes ??
      leakSummary.indirectly_lost ??
      unwrapped.indirectly_lost_bytes ??
      unwrapped.indirectly_lost,
    0
  );

  const indirectlyLostBlocks = safeNum(
    summary.indirectly_lost_blocks ??
      leakSummary.indirectly_lost_blocks ??
      unwrapped.indirectly_lost_blocks,
    0
  );

  const possiblyLostBytes = safeNum(
    summary.possibly_lost_bytes ??
      summary.possibly_lost ??
      leakSummary.possibly_lost_bytes ??
      leakSummary.possibly_lost ??
      unwrapped.possibly_lost_bytes ??
      unwrapped.possibly_lost,
    0
  );

  const possiblyLostBlocks = safeNum(
    summary.possibly_lost_blocks ??
      leakSummary.possibly_lost_blocks ??
      unwrapped.possibly_lost_blocks,
    0
  );

  const stillReachableBytes = safeNum(
    summary.still_reachable_bytes ??
      summary.still_reachable ??
      leakSummary.still_reachable_bytes ??
      leakSummary.still_reachable ??
      unwrapped.still_reachable_bytes ??
      unwrapped.still_reachable,
    0
  );

  const stillReachableBlocks = safeNum(
    summary.still_reachable_blocks ??
      leakSummary.still_reachable_blocks ??
      unwrapped.still_reachable_blocks,
    0
  );

  const suppressedBytes = safeNum(
    summary.suppressed_bytes ??
      leakSummary.suppressed_bytes ??
      unwrapped.suppressed_bytes,
    0
  );

  const suppressedBlocks = safeNum(
    summary.suppressed_blocks ??
      leakSummary.suppressed_blocks ??
      unwrapped.suppressed_blocks,
    0
  );

  const rawErrors = Array.isArray(unwrapped.errors) ? unwrapped.errors : [];
  const rawLeaks = Array.isArray(unwrapped.leaks) ? unwrapped.leaks : [];
  const combinedList = [...rawErrors];
  const seenIds = new Set<string>(
    rawErrors
      .map((e) =>
        e && typeof e === "object"
          ? String((e as Record<string, unknown>).id ?? "")
          : ""
      )
      .filter(Boolean)
  );

  rawLeaks.forEach((lk, idx) => {
    if (lk && typeof lk === "object") {
      const lkId = String((lk as Record<string, unknown>).id ?? `leak-${idx}`);
      if (!seenIds.has(lkId)) {
        seenIds.add(lkId);
        combinedList.push(lk);
      }
    }
  });

  const diagnostics: ValgrindDiagnosticItem[] = combinedList
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((item, idx) => {
      const rawStack = Array.isArray(item.stack)
        ? item.stack
        : Array.isArray(item.frames)
        ? item.frames
        : [];
      const stack: ValgrindStackFrame[] = rawStack
        .filter(
          (f): f is Record<string, unknown> =>
            f !== null && typeof f === "object"
        )
        .map((f) => ({
          ip: String(f.ip ?? ""),
          fn: String(f.fn ?? f.func ?? f.function ?? "??"),
          file: String(f.file ?? ""),
          line: safeNum(f.line, 0),
          is_user_code: Boolean(f.is_user_code),
        }));

      const auxwhat = Array.isArray(item.auxwhat)
        ? item.auxwhat.map((a) => String(a))
        : [];

      const kindStr = String(item.kind ?? item.type ?? "MemoryDiagnostic");
      const whatStr = String(
        item.what ?? item.message ?? item.description ?? kindStr
      );

      return {
        id: String(item.id ?? `diag-${idx}`),
        kind: kindStr,
        type: kindStr,
        what: whatStr,
        message: whatStr,
        description: whatStr,
        bytes_leaked: safeNum(
          item.bytes_leaked ?? item.leaked_bytes ?? item.bytes,
          0
        ),
        blocks_leaked: safeNum(
          item.blocks_leaked ?? item.leaked_blocks ?? item.blocks,
          0
        ),
        file: String(item.file ?? ""),
        line: safeNum(item.line, 0),
        function: String(item.function ?? item.fn ?? ""),
        auxwhat,
        stack,
        frames: stack,
      };
    });

  const errorCount = Math.max(
    diagnostics.length,
    safeNum(summary.error_count ?? unwrapped.error_count, 0)
  );

  const totalLeaked =
    definitelyLostBytes +
    indirectlyLostBytes +
    possiblyLostBytes +
    stillReachableBytes;

  const isClean =
    compileError === null &&
    status !== "error" &&
    status !== "timeout" &&
    status !== "compile_error" &&
    (typeof unwrapped.is_clean === "boolean"
      ? unwrapped.is_clean
      : typeof summary.is_clean === "boolean"
      ? summary.is_clean
      : errorCount === 0 && totalLeaked === 0 && inUseAtExitBytes === 0);

  const rawLog = String(
    unwrapped.clean_log ??
      unwrapped.raw_output ??
      unwrapped.valgrind_output ??
      unwrapped.log ??
      ""
  );

  return {
    status,
    isClean,
    compileError,
    stdout: String(unwrapped.stdout ?? ""),
    stderr: String(unwrapped.stderr ?? ""),
    rawLog,
    totalAllocs,
    totalFrees,
    totalBytesAllocated,
    inUseAtExitBytes,
    inUseAtExitBlocks,
    definitelyLostBytes,
    definitelyLostBlocks,
    indirectlyLostBytes,
    indirectlyLostBlocks,
    possiblyLostBytes,
    possiblyLostBlocks,
    stillReachableBytes,
    stillReachableBlocks,
    suppressedBytes,
    suppressedBlocks,
    errorCount,
    diagnostics,
  };
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class HeapVisualizerErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage:
        error?.message || "Unexpected rendering error in HeapVisualizer.",
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("HeapVisualizer caught an error:", error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 bg-slate-950 text-center">
          <div className="max-w-md w-full rounded-xl bg-rose-950/40 border border-rose-500/50 p-6 shadow-xl">
            <AlertTriangle className="w-10 h-10 text-rose-400 mx-auto mb-3" />
            <h3 className="text-sm font-mono font-bold text-rose-200">
              Valgrind Audit View Recovery
            </h3>
            <p className="text-xs font-mono text-rose-300/80 mt-2 break-words">
              {this.state.errorMessage}
            </p>
            <button
              type="button"
              onClick={() =>
                this.setState({ hasError: false, errorMessage: "" })
              }
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/50 text-rose-100 text-xs font-mono font-semibold transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Audit View</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const HeapVisualizerContent: React.FC<HeapVisualizerProps> = (props) => {
  const [showRawLog, setShowRawLog] = useState<boolean>(true);

  const isBusy = Boolean(
    props.isLoading || props.isAnalyzing || props.isAuditing
  );

  // Resolve payload across all possible prop aliases
  const rawPayload =
    props.data ??
    props.report ??
    props.audit ??
    props.valgrind ??
    props.result ??
    props.analysis ??
    props.valgrindData ??
    props.auditData ??
    null;

  const handleLineClick = (line: number) => {
    if (line <= 0) return;
    if (props.onJumpToLine) props.onJumpToLine(line);
    else if (props.onSelectLine) props.onSelectLine(line);
  };

  if (isBusy) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-slate-300 p-8 text-center">
        <Activity className="w-10 h-10 text-sky-400 animate-pulse mb-3" />
        <p className="text-sm font-mono font-semibold">
          Running Valgrind Memcheck &amp; Heap Leak Audit...
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Instrumenting allocations, frees, and uninitialized memory origins
        </p>
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-950 p-6">
        <div className="max-w-2xl w-full rounded-xl bg-rose-950/35 border border-rose-500/50 p-5 shadow-lg">
          <div className="flex items-center gap-2.5 text-rose-300 font-mono text-sm font-bold mb-2">
            <FileWarning className="w-5 h-5 text-rose-400 shrink-0" />
            <span>Compilation / Valgrind Error</span>
          </div>
          <pre className="text-xs font-mono text-rose-200/90 bg-slate-950/80 border border-rose-500/30 rounded-lg p-3.5 overflow-x-auto whitespace-pre-wrap">
            {props.error}
          </pre>
        </div>
      </div>
    );
  }

  if (!rawPayload || Object.keys(rawPayload).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-slate-400 p-12 text-center">
        <Cpu className="w-12 h-12 text-slate-600 mb-3 stroke-[1.5]" />
        <p className="text-sm font-medium text-slate-300">
          No memory audit data available.
        </p>
        <p className="text-xs text-slate-500 max-w-md mt-1">
          Click{" "}
          <span className="text-emerald-400 font-mono font-semibold">
            Run Valgrind Audit
          </span>{" "}
          to analyze allocations, frees, and memory leaks.
        </p>
        {props.onRunAudit && (
          <button
            type="button"
            onClick={props.onRunAudit}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-bold shadow-lg transition cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Run Valgrind Audit Now</span>
          </button>
        )}
      </div>
    );
  }

  const audit = normalizeValgrindPayload(rawPayload);

  if (audit.compileError) {
    return (
      <div className="flex flex-col gap-4 p-5 overflow-y-auto h-full bg-slate-950">
        <div className="rounded-xl bg-rose-950/40 border border-rose-500/60 p-5 shadow-lg">
          <div className="flex items-center gap-2.5 text-rose-300 font-mono text-sm font-bold mb-3">
            <FileWarning className="w-5 h-5 text-rose-400 shrink-0" />
            <span>GCC Compilation Failed</span>
          </div>
          <pre className="text-xs font-mono text-rose-200 bg-slate-950/90 border border-rose-500/30 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap">
            {audit.compileError}
          </pre>
        </div>
      </div>
    );
  }

  const unfreedBlocksCount = Math.max(0, audit.totalAllocs - audit.totalFrees);
  const freeRatioPct =
    audit.totalAllocs > 0
      ? Math.min(100, Math.round((audit.totalFrees / audit.totalAllocs) * 100))
      : 100;

  const leakCategories = [
    {
      label: "Definitely Lost",
      bytes: audit.definitelyLostBytes,
      blocks: audit.definitelyLostBlocks,
      activeClass:
        "bg-rose-950/60 border-rose-500/70 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.2)]",
      badgeClass: "text-rose-400",
    },
    {
      label: "Indirectly Lost",
      bytes: audit.indirectlyLostBytes,
      blocks: audit.indirectlyLostBlocks,
      activeClass: "bg-orange-950/60 border-orange-500/70 text-orange-200",
      badgeClass: "text-orange-400",
    },
    {
      label: "Possibly Lost",
      bytes: audit.possiblyLostBytes,
      blocks: audit.possiblyLostBlocks,
      activeClass: "bg-amber-950/60 border-amber-500/70 text-amber-200",
      badgeClass: "text-amber-400",
    },
    {
      label: "Still Reachable",
      bytes: audit.stillReachableBytes,
      blocks: audit.stillReachableBlocks,
      activeClass: "bg-sky-950/60 border-sky-500/70 text-sky-200",
      badgeClass: "text-sky-400",
    },
  ];

  return (
    <div className="flex flex-col gap-5 p-5 overflow-y-auto h-full bg-slate-950 text-slate-100">
      {/* 1. Top Audit Verdict Banner */}
      <div
        className={`rounded-xl border p-4 shadow-lg flex flex-wrap items-center justify-between gap-4 ${
          audit.isClean
            ? "bg-emerald-950/35 border-emerald-500/50 text-emerald-200"
            : "bg-rose-950/40 border-rose-500/60 text-rose-200"
        }`}
      >
        <div className="flex items-center gap-3">
          {audit.isClean ? (
            <ShieldCheck className="w-7 h-7 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-7 h-7 text-rose-400 shrink-0" />
          )}
          <div>
            <h3 className="font-mono text-sm font-extrabold tracking-tight">
              {audit.isClean
                ? "MEMORY AUDIT PASSED — All Heap Blocks Were Freed (0 Errors)"
                : `MEMORY ISSUES DETECTED — ${formatNum(
                    audit.errorCount
                  )} Diagnostic(s), ${formatNum(
                    audit.inUseAtExitBytes
                  )} B In Use at Exit`}
            </h3>
            <p className="text-xs font-mono opacity-85 mt-0.5">
              {audit.isClean
                ? `Total heap usage: ${formatNum(
                    audit.totalAllocs
                  )} allocs, ${formatNum(
                    audit.totalFrees
                  )} frees, ${formatNum(
                    audit.totalBytesAllocated
                  )} bytes allocated.`
                : `Total heap usage: ${formatNum(
                    audit.totalAllocs
                  )} allocs, ${formatNum(
                    audit.totalFrees
                  )} frees (${formatNum(
                    unfreedBlocksCount
                  )} unfreed), ${formatNum(
                    audit.totalBytesAllocated
                  )} bytes allocated.`}
            </p>
          </div>
        </div>

        <span
          className={`px-3 py-1 rounded-full font-mono text-xs font-extrabold border ${
            audit.isClean
              ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-300"
              : "bg-rose-500/20 border-rose-400/60 text-rose-300"
          }`}
        >
          {audit.isClean ? "HEAP CLEAN" : "LEAK / ERROR"}
        </span>
      </div>

      {/* 2. Heap Lifecycle KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400 mb-1.5">
            <span>ALLOCATIONS VS. FREES</span>
            <Layers className="w-4 h-4 text-sky-400" />
          </div>
          <div className="flex items-baseline gap-2 font-mono">
            <span className="text-xl font-extrabold text-slate-100">
              {formatNum(audit.totalFrees)} / {formatNum(audit.totalAllocs)}
            </span>
            <span className="text-xs text-slate-400">
              freed ({freeRatioPct}%)
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-950 border border-slate-800 mt-2.5 overflow-hidden">
            <div
              style={{ width: `${freeRatioPct}%` }}
              className={`h-full transition-all duration-300 ${
                unfreedBlocksCount === 0 ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400 mb-1.5">
            <span>TOTAL BYTES ALLOCATED</span>
            <Cpu className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-xl font-mono font-extrabold text-indigo-300">
            {formatNum(audit.totalBytesAllocated)} B
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-2">
            Across {formatNum(audit.totalAllocs)} heap allocation call(s)
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400 mb-1.5">
            <span>IN USE AT EXIT</span>
            <CheckCircle2
              className={`w-4 h-4 ${
                audit.inUseAtExitBytes === 0
                  ? "text-emerald-400"
                  : "text-rose-400"
              }`}
            />
          </div>
          <div
            className={`text-xl font-mono font-extrabold ${
              audit.inUseAtExitBytes === 0
                ? "text-emerald-400"
                : "text-rose-400"
            }`}
          >
            {formatNum(audit.inUseAtExitBytes)} B
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-2">
            In {formatNum(audit.inUseAtExitBlocks)} active block(s) at exit
          </div>
        </div>
      </div>

      {/* 3. Leak Summary Breakdown */}
      <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4">
        <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">
          Valgrind Leak Summary Breakdown
        </h4>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {leakCategories.map((cat) => {
            const hasLeak = cat.bytes > 0 || cat.blocks > 0;
            return (
              <div
                key={cat.label}
                className={`rounded-lg border p-3 font-mono transition-colors ${
                  hasLeak
                    ? cat.activeClass
                    : "bg-slate-950/80 border-slate-800/80 text-slate-400"
                }`}
              >
                <div className="text-[11px] uppercase tracking-tight opacity-85">
                  {cat.label}
                </div>
                <div
                  className={`text-base font-extrabold mt-1 ${
                    hasLeak ? cat.badgeClass : "text-slate-300"
                  }`}
                >
                  {formatNum(cat.bytes)} B
                </div>
                <div className="text-[11px] opacity-75 mt-0.5">
                  in {formatNum(cat.blocks)} block(s)
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Detailed Valgrind Diagnostics & Call Stacks */}
      {audit.diagnostics.length > 0 && (
        <div className="flex flex-col gap-3">
          <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">
            Detailed Memory Diagnostics &amp; Stack Traces (
            {formatNum(audit.diagnostics.length)})
          </h4>

          {audit.diagnostics.map((diag, idx) => {
            const isLeak = (diag.kind || "").startsWith("Leak_");
            const leakedBytes = safeNum(diag.bytes_leaked, 0);
            const leakedBlocks = safeNum(diag.blocks_leaked, 0);
            const stackFrames = Array.isArray(diag.stack) ? diag.stack : [];

            return (
              <div
                key={diag.id || `diag-${idx}`}
                className="rounded-xl bg-slate-900/95 border border-rose-500/40 p-4 shadow-md"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5 mb-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span className="px-2 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-rose-300 font-mono text-xs font-bold">
                      {diag.kind}
                    </span>
                    {diag.file && safeNum(diag.line, 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => handleLineClick(safeNum(diag.line, 0))}
                        className="px-2 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 font-mono text-xs font-semibold transition cursor-pointer"
                      >
                        {diag.file}:{formatNum(diag.line)}
                      </button>
                    )}
                  </div>

                  {isLeak && leakedBytes > 0 && (
                    <span className="px-2.5 py-0.5 rounded-full bg-rose-950 border border-rose-500/50 text-rose-200 font-mono text-xs font-bold">
                      {formatNum(leakedBytes)} B leaked in{" "}
                      {formatNum(leakedBlocks)} block(s)
                    </span>
                  )}
                </div>

                <p className="text-xs font-mono text-slate-200 font-semibold mb-2">
                  {diag.what}
                </p>

                {Array.isArray(diag.auxwhat) && diag.auxwhat.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {diag.auxwhat.map((aux, aIdx) => (
                      <p
                        key={`aux-${aIdx}`}
                        className="text-xs font-mono text-amber-300/90 pl-3 border-l-2 border-amber-500/50"
                      >
                        {aux}
                      </p>
                    ))}
                  </div>
                )}

                {stackFrames.length > 0 && (
                  <div className="rounded-lg bg-slate-950 border border-slate-800 p-2.5 space-y-1 font-mono text-xs">
                    {stackFrames.map((fr, fIdx) => {
                      const fLine = safeNum(fr.line, 0);
                      const isUserFrame =
                        Boolean(fr.is_user_code) ||
                        Boolean(fr.file && fr.file.endsWith("target.c"));
                      return (
                        <div
                          key={`frame-${fIdx}`}
                          onClick={() => isUserFrame && handleLineClick(fLine)}
                          className={`flex flex-wrap items-center justify-between gap-2 px-2 py-1 rounded ${
                            isUserFrame
                              ? "bg-sky-950/50 border border-sky-500/30 text-sky-200 cursor-pointer hover:bg-sky-900/50"
                              : "text-slate-400"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500">#{fIdx}</span>
                            <span className="font-bold text-emerald-300">
                              {fr.fn || "??"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            {fr.file ? (
                              <span
                                className={
                                  isUserFrame
                                    ? "text-sky-300 font-bold underline"
                                    : "text-slate-500"
                                }
                              >
                                {fr.file}
                                {fLine > 0 ? `:${formatNum(fLine)}` : ""}
                              </span>
                            ) : (
                              <span className="text-slate-600">{fr.ip}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 5. Program Standard Output (`stdout`) */}
      {audit.stdout.trim() !== "" && (
        <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-slate-400 mb-2">
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>Program Standard Output (stdout)</span>
          </div>
          <pre className="text-xs font-mono text-emerald-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {audit.stdout}
          </pre>
        </div>
      )}

      {/* 6. Collapsible Raw Valgrind Log */}
      {audit.rawLog.trim() !== "" && (
        <div className="rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowRawLog((prev) => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-mono font-semibold text-slate-300 hover:bg-slate-800/60 transition cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-sky-400" />
              <span>Raw Valgrind Memcheck Report</span>
            </div>
            {showRawLog ? (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {showRawLog && (
            <pre className="text-xs font-mono text-slate-300 bg-slate-950 border-t border-slate-800 p-4 overflow-x-auto whitespace-pre-wrap max-h-96">
              {audit.rawLog}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export const HeapVisualizer: React.FC<HeapVisualizerProps> = (props) => {
  return (
    <HeapVisualizerErrorBoundary>
      <HeapVisualizerContent {...props} />
    </HeapVisualizerErrorBoundary>
  );
};

export default HeapVisualizer;
