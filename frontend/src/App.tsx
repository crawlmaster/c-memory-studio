/**
 * frontend/src/App.tsx
 * Master 50/50 split-pane layout for C-Memory-Studio.
 * - Immediately flushes stale GDB trace frames, Cytoscape graph nodes, and Valgrind reports
 *   whenever the user edits code in Monaco or starts a new trace (`resetSession` + `sessionId`).
 * - Passes `graphNodes` to `ArrayVisualizer` so struct-embedded buffers (`s->data`, `h->array`)
 *   display sister container fields (`capacity`, `top`, `size`, struct address).
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useDebugSession } from "./hooks/useDebugSession";
import { CodeEditor } from "./components/Editor/CodeEditor";
import { ArrayVisualizer } from "./components/Visualizer/ArrayVisualizer";
import { GraphVisualizer } from "./components/Visualizer/GraphVisualizer";
import { HeapVisualizer } from "./components/HeapView/HeapVisualizer";
import { type HighlightTarget } from "./types/debug";
import {
  BarChart3,
  Share2,
  ShieldAlert,
  Terminal,
  AlertCircle,
  RotateCcw,
  X,
} from "lucide-react";

type StudioTab = "arrays" | "graph" | "valgrind";

const LOCAL_STORAGE_CODE_KEY = "c_memory_studio_saved_code";

export const DEFAULT_DEMO_C_CODE = `#include <stdlib.h>

typedef struct stack_t {
    int *data;
    int top;
    int capacity;
} *stack;

stack create_stack(int cap) {
    stack s = (stack)malloc(sizeof(struct stack_t));
    s->capacity = cap;
    s->top = -1;
    s->data = (int*)calloc(cap, sizeof(int));
    return s;
}

void push(stack s, int val) {
    if (s->top < s->capacity - 1) {
        s->top++;
        s->data[s->top] = val;
    }
}

int main(void) {
    stack s = create_stack(5);
    push(s, 10);
    push(s, 25);
    push(s, 40);

    // Intentional leak of s->data for Valgrind demonstration
    free(s);
    return 0;
}
`;

export const App: React.FC = () => {
  const [code, setCode] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(LOCAL_STORAGE_CODE_KEY);
      return saved !== null && saved.trim().length > 0
        ? saved
        : DEFAULT_DEMO_C_CODE;
    } catch {
      return DEFAULT_DEMO_C_CODE;
    }
  });

  const [activeTab, setActiveTab] = useState<StudioTab>("arrays");
  const [highlightedLine, setHighlightedLine] =
    useState<HighlightTarget | null>(null);

  const userOverrodeTabRef = useRef<boolean>(false);

  const {
    sessionId,
    stepIndex,
    totalSteps,
    currentFrame,
    isConnecting,
    isRunning,
    isPlaying,
    isAuditingValgrind,
    playbackSpeedMs,
    error,
    valgrindData,
    startTrace,
    stepNext,
    stepPrev,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeedMs,
    runValgrindAudit,
    resetSession,
    clearError,
  } = useDebugSession();

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_CODE_KEY, code);
    } catch {
      // Ignore quota errors
    }
  }, [code]);

  useEffect(() => {
    if (!currentFrame || userOverrodeTabRef.current) return;

    const hasGraphNodes =
      currentFrame.graph && currentFrame.graph.nodes.length > 0;
    const hasArrays = currentFrame.arrays && currentFrame.arrays.length > 0;

    if (hasGraphNodes && !hasArrays) {
      setActiveTab("graph");
    } else if (hasArrays && !hasGraphNodes) {
      setActiveTab("arrays");
    }
  }, [currentFrame]);

  // Immediately flush stale GDB frames, graph nodes, and Valgrind reports when code is edited
  const handleCodeChange = useCallback(
    (nextCode: string) => {
      setCode(nextCode);
      if (totalSteps > 0 || valgrindData !== null || isRunning || isConnecting) {
        resetSession();
      }
      if (highlightedLine !== null) {
        setHighlightedLine(null);
      }
    },
    [totalSteps, valgrindData, isRunning, isConnecting, resetSession, highlightedLine]
  );

  const handleManualTabSelect = useCallback((tab: StudioTab) => {
    userOverrodeTabRef.current = true;
    setActiveTab(tab);
  }, []);

  const handleStartTrace = useCallback(() => {
    userOverrodeTabRef.current = false;
    setHighlightedLine(null);
    setActiveTab("arrays");
    startTrace(code);
  }, [code, startTrace]);

  const handleRunValgrind = useCallback(async () => {
    userOverrodeTabRef.current = true;
    setActiveTab("valgrind");

    const result = await runValgrindAudit(code);
    if (result?.blocks && result.blocks.length > 0) {
      const firstBlock = result.blocks[0];
      const targetLine =
        firstBlock.detected_at?.line || firstBlock.allocated_at?.line || 0;
      if (targetLine > 0) {
        setHighlightedLine({
          line: targetLine,
          type: result.summary?.has_fatal_errors ? "error" : "warning",
          message: firstBlock.description,
          timestamp: Date.now(),
        });
      }
    }
  }, [code, runValgrindAudit]);

  const handleResetDemoCode = useCallback(() => {
    resetSession();
    setHighlightedLine(null);
    setCode(DEFAULT_DEMO_C_CODE);
    try {
      window.localStorage.setItem(LOCAL_STORAGE_CODE_KEY, DEFAULT_DEMO_C_CODE);
    } catch {
      // Ignore
    }
  }, [resetSession]);

  const arrayCount = currentFrame?.arrays?.length || 0;
  const graphNodeCount = currentFrame?.graph?.nodes?.length || 0;
  const valgrindIssueCount = valgrindData?.blocks?.length || 0;

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Application Header Bar */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-500/40 flex items-center justify-center text-sky-400">
            <Terminal className="w-4 h-4" />
          </div>
          <h1 className="text-sm font-mono font-bold tracking-tight text-white flex items-center gap-2">
            <span>C-Memory-Studio</span>
            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 text-sky-400 rounded border border-slate-700">
              GDB/MI + Valgrind XML v4
            </span>
          </h1>

          <button
            type="button"
            onClick={handleResetDemoCode}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-mono transition cursor-pointer ml-2"
            title="Reset Editor to Default C Demo Snippet"
          >
            <RotateCcw className="w-3 h-3 text-sky-400" />
            <span>Reset to Demo Code</span>
          </button>
        </div>

        {/* Call Stack Pill Trail */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="text-slate-500 hidden sm:inline">Call Stack:</span>
          <div className="flex items-center gap-1">
            {(currentFrame?.call_stack || ["main"]).map((fn, idx, arr) => (
              <React.Fragment key={`${fn}-${idx}`}>
                <span
                  className={`px-2 py-0.5 rounded border ${
                    idx === arr.length - 1
                      ? "bg-sky-950/90 border-sky-600 text-sky-300 font-bold"
                      : "bg-slate-800/80 border-slate-700 text-slate-400"
                  }`}
                >
                  {fn}()
                </span>
                {idx < arr.length - 1 && (
                  <span className="text-slate-600">→</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </header>

      {/* Global Error Banner */}
      {error && (
        <div className="bg-rose-950/95 border-b border-rose-600 px-4 py-2.5 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 overflow-x-auto">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <pre className="text-xs font-mono text-rose-200 whitespace-pre-wrap">
              {error}
            </pre>
          </div>
          <button
            type="button"
            onClick={clearError}
            className="text-rose-300 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main 50/50 Split Studio Workspace */}
      <main className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
        {/* Left 50% Pane: Monaco C Code Editor */}
        <section className="w-full lg:w-1/2 h-1/2 lg:h-full min-h-0">
          <CodeEditor
            code={code}
            onChange={handleCodeChange}
            activeLine={currentFrame?.line ?? null}
            highlightedLine={highlightedLine}
            stepIndex={stepIndex}
            totalSteps={totalSteps}
            isConnecting={isConnecting}
            isRunning={isRunning}
            isPlaying={isPlaying}
            isAuditingValgrind={isAuditingValgrind}
            playbackSpeedMs={playbackSpeedMs}
            onStartTrace={handleStartTrace}
            onStopTrace={stop}
            onStepNext={stepNext}
            onStepPrev={stepPrev}
            onPlay={play}
            onPause={pause}
            onSeekTo={seekTo}
            onSpeedChange={setPlaybackSpeedMs}
            onRunValgrind={handleRunValgrind}
          />
        </section>

        {/* Right 50% Pane: Tabbed Memory & Data Structure Visualizer Studio */}
        <section className="w-full lg:w-1/2 h-1/2 lg:h-full flex flex-col min-h-0 bg-slate-950">
          {/* Studio Tab Navigation Header */}
          <div className="flex items-center border-b border-slate-800 bg-slate-900 px-2 shrink-0">
            <button
              type="button"
              onClick={() => handleManualTabSelect("arrays")}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono font-semibold border-b-2 transition cursor-pointer ${
                activeTab === "arrays"
                  ? "border-sky-400 text-sky-400 bg-slate-950/60"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Array &amp; Sorting</span>
              {arrayCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/40">
                  {arrayCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleManualTabSelect("graph")}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono font-semibold border-b-2 transition cursor-pointer ${
                activeTab === "graph"
                  ? "border-sky-400 text-sky-400 bg-slate-950/60"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>Pointers &amp; Graph Mesh</span>
              {graphNodeCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {graphNodeCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleManualTabSelect("valgrind")}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono font-semibold border-b-2 transition cursor-pointer ${
                activeTab === "valgrind"
                  ? "border-amber-400 text-amber-400 bg-slate-950/60"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Heap &amp; Leaks (Valgrind)</span>
              {valgrindIssueCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  {valgrindIssueCount}
                </span>
              )}
            </button>
          </div>

          {/* Active Visualizer Viewport */}
          <div className="flex-1 min-h-0 relative">
            {activeTab === "arrays" && (
              <ArrayVisualizer
                key={`arrays-${sessionId}`}
                arrays={currentFrame?.arrays || []}
                locals={currentFrame?.stack_frames?.locals}
                graphNodes={currentFrame?.graph?.nodes || []}
              />
            )}

            {activeTab === "graph" && (
              <GraphVisualizer
                key={`graph-${sessionId}`}
                graph={currentFrame?.graph || { nodes: [], edges: [] }}
                locals={currentFrame?.stack_frames?.locals}
                isConnecting={isConnecting}
              />
            )}

            {activeTab === "valgrind" && (
              <HeapVisualizer
                key={`valgrind-${sessionId}`}
                valgrindData={valgrindData}
                isAuditing={isAuditingValgrind}
                onRunAudit={handleRunValgrind}
                onSelectLine={setHighlightedLine}
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
