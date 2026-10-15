/**
 * frontend/src/App.tsx
 * Master 50/50 split-pane layout for C-Memory-Studio:
 * - Left Pane: Monaco CodeEditor + Debugger Controls
 * - Right Pane: Tabbed Studio ("Array & Sorting", "Pointers & Graph Mesh", "Heap & Leaks (Valgrind)")
 * - Automatic tab switching when arrays/graphs appear or Valgrind completes
 */

import React, { useState, useEffect, useCallback } from "react";
import { useDebugSession } from "./hooks/useDebugSession";
import { CodeEditor } from "./components/Editor/CodeEditor";
import { ArrayVisualizer } from "./components/Visualizer/ArrayVisualizer";
import { GraphVisualizer } from "./components/Visualizer/GraphVisualizer";
import { HeapVisualizer } from "./components/HeapView/HeapVisualizer";
import type { HighlightTarget } from "./types/debug";
import {
  BarChart3,
  Share2,
  ShieldAlert,
  Terminal,
  AlertCircle,
  X,
} from "lucide-react";

type StudioTab = "arrays" | "graph" | "valgrind";

const DEFAULT_DEMO_C_CODE = `#include <stdlib.h>

struct Node {
    int val;
    struct Node *next;
};

struct Node* create_node(int v) {
    struct Node *n = (struct Node*)malloc(sizeof(struct Node));
    n->val = v;
    n->next = NULL;
    return n;
}

int main(void) {
    // 1. Contiguous Array & Bubble Sort Pass
    int arr[4] = {8, 2, 5, 1};
    for (int i = 0; i < 3; i++) {
        int j = i + 1;
        if (arr[i] > arr[j]) {
            int tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
    }

    // 2. Dynamic Linked List Pointer Mesh
    struct Node *head = create_node(10);
    struct Node *second = create_node(20);
    head->next = second;

    struct Node *curr = head;
    while (curr != NULL) {
        curr = curr->next;
    }

    // Intentional leak of 'second' for Valgrind Audit demonstration
    free(head);
    return 0;
}
`;

export const App: React.FC = () => {
  const [code, setCode] = useState<string>(DEFAULT_DEMO_C_CODE);
  const [activeTab, setActiveTab] = useState<StudioTab>("arrays");
  const [highlightedLine, setHighlightedLine] =
    useState<HighlightTarget | null>(null);

  const {
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
    clearError,
  } = useDebugSession();

  // Auto-switch between "Array & Sorting" and "Pointers & Graph Mesh" based on active frame content
  useEffect(() => {
    if (!currentFrame) return;

    const hasGraphNodes =
      currentFrame.graph && currentFrame.graph.nodes.length > 0;
    const hasArrays = currentFrame.arrays && currentFrame.arrays.length > 0;

    if (hasGraphNodes && activeTab === "arrays" && !hasArrays) {
      setActiveTab("graph");
    } else if (hasArrays && activeTab === "valgrind") {
      setActiveTab("arrays");
    }
  }, [currentFrame, activeTab]);

  const handleStartTrace = useCallback(() => {
    setHighlightedLine(null);
    startTrace(code);
  }, [code, startTrace]);

  const handleRunValgrind = useCallback(async () => {
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

  const arrayCount = currentFrame?.arrays?.length || 0;
  const graphNodeCount = currentFrame?.graph?.nodes?.length || 0;
  const valgrindIssueCount = valgrindData?.blocks?.length || 0;

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Application Header Bar */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-500/40 flex items-center justify-center text-sky-400">
            <Terminal className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-mono font-bold tracking-tight text-white flex items-center gap-2">
              <span>C-Memory-Studio</span>
              <span className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 text-sky-400 rounded border border-slate-700">
                GDB/MI + Valgrind XML v4
              </span>
            </h1>
          </div>
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

      {/* Global Error Banner (Compiler stderr / Connection errors) */}
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
            onChange={setCode}
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
              onClick={() => setActiveTab("arrays")}
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
              onClick={() => setActiveTab("graph")}
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
              onClick={() => setActiveTab("valgrind")}
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
                arrays={currentFrame?.arrays || []}
                locals={currentFrame?.stack_frames?.locals}
              />
            )}

            {activeTab === "graph" && (
              <GraphVisualizer
                graph={currentFrame?.graph || { nodes: [], edges: [] }}
              />
            )}

            {activeTab === "valgrind" && (
              <HeapVisualizer
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
