/**
 * frontend/src/components/Editor/CodeEditor.tsx
 * Monaco Editor wrapper with:
 * - Active execution line highlight + glyph margin arrow (`currentFrame.line`)
 * - Valgrind warning/error line jump + flash decoration (`highlightedLine`)
 * - Full execution & time-travel debugging toolbar with keyboard shortcut F10
 */

import React, { useRef, useEffect, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import {
  Play,
  Pause,
  Square,
  SkipForward,
  SkipBack,
  ShieldAlert,
  Cpu,
  Gauge,
  Loader2,
} from "lucide-react";
import { type HighlightTarget } from "../../types/debug";

export interface CodeEditorProps {
  code: string;
  onChange: (value: string) => void;
  activeLine: number | null;
  highlightedLine: HighlightTarget | null;
  stepIndex: number;
  totalSteps: number;
  isConnecting: boolean;
  isRunning: boolean;
  isPlaying: boolean;
  isAuditingValgrind: boolean;
  playbackSpeedMs: number;
  onStartTrace: () => void;
  onStopTrace: () => void;
  onStepNext: () => void;
  onStepPrev: () => void;
  onPlay: () => void;
  onPause: () => void;
  onSeekTo: (stepIdx: number) => void;
  onSpeedChange: (speedMs: number) => void;
  onRunValgrind: () => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  code,
  onChange,
  activeLine,
  highlightedLine,
  stepIndex,
  totalSteps,
  isConnecting,
  isRunning,
  isPlaying,
  isAuditingValgrind,
  playbackSpeedMs,
  onStartTrace,
  onStopTrace,
  onStepNext,
  onStepPrev,
  onPlay,
  onPause,
  onSeekTo,
  onSpeedChange,
  onRunValgrind,
}) => {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const execDecorationsRef = useRef<string[]>([]);
  const flashDecorationsRef = useRef<string[]>([]);
  const flashTimeoutRef = useRef<number | null>(null);

  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;

      // Bind F10 inside Monaco to Step Forward
      editor.addCommand(monacoInstance.KeyCode.F10, () => {
        onStepNext();
      });
    },
    [onStepNext]
  );

  // Global F10 listener when focus is outside Monaco
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F10") {
        e.preventDefault();
        onStepNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onStepNext]);

  // Apply execution line decoration whenever `activeLine` changes
  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editor || !monacoInstance) return;

    if (!activeLine || activeLine <= 0) {
      execDecorationsRef.current = editor.deltaDecorations(
        execDecorationsRef.current,
        []
      );
      return;
    }

    const newDecorations: Monaco.editor.IModelDeltaDecoration[] = [
      {
        range: new monacoInstance.Range(activeLine, 1, activeLine, 1),
        options: {
          isWholeLine: true,
          className: "cms-active-exec-line",
          glyphMarginClassName: "cms-active-exec-glyph",
          overviewRuler: {
            color: "#38bdf8",
            position: monacoInstance.editor.OverviewRulerLane.Full,
          },
        },
      },
    ];

    execDecorationsRef.current = editor.deltaDecorations(
      execDecorationsRef.current,
      newDecorations
    );
    editor.revealLineInCenterIfOutsideViewport(activeLine);
  }, [activeLine]);

  // Apply Valgrind jump & flash warning decoration whenever `highlightedLine` triggers
  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editor || !monacoInstance || !highlightedLine) return;

    const { line, type, message } = highlightedLine;
    if (line <= 0) return;

    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });

    const isError = type === "error";
    const flashDeco: Monaco.editor.IModelDeltaDecoration[] = [
      {
        range: new monacoInstance.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: isError ? "cms-valgrind-error-line" : "cms-valgrind-warn-line",
          glyphMarginClassName: isError
            ? "cms-valgrind-error-glyph"
            : "cms-valgrind-warn-glyph",
          glyphMarginHoverMessage: message ? { value: `**Valgrind:** ${message}` } : undefined,
        },
      },
    ];

    flashDecorationsRef.current = editor.deltaDecorations(
      flashDecorationsRef.current,
      flashDeco
    );

    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    flashTimeoutRef.current = window.setTimeout(() => {
      if (editorRef.current) {
        flashDecorationsRef.current = editorRef.current.deltaDecorations(
          flashDecorationsRef.current,
          []
        );
      }
    }, 3200);
  }, [highlightedLine]);

  return (
    <div className="flex flex-col h-full bg-slate-950 border-r border-slate-800 select-none">
      {/* Embedded CSS for Monaco Line & Glyph Decorations */}
      <style>{`
        .cms-active-exec-line {
          background: rgba(56, 189, 248, 0.16) !important;
          border-left: 3px solid #38bdf8 !important;
        }
        .cms-active-exec-glyph {
          background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%2338bdf8'><polygon points='3,2 14,8 3,14'/></svg>") no-repeat center center;
          background-size: 12px 12px;
        }
        .cms-valgrind-error-line {
          background: rgba(239, 68, 68, 0.28) !important;
          border-left: 4px solid #ef4444 !important;
          animation: cmsPulseRed 1s ease-in-out infinite alternate;
        }
        .cms-valgrind-warn-line {
          background: rgba(245, 158, 11, 0.25) !important;
          border-left: 4px solid #f59e0b !important;
        }
        .cms-valgrind-error-glyph {
          background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23ef4444'><circle cx='8' cy='8' r='6'/></svg>") no-repeat center center;
          background-size: 11px 11px;
        }
        .cms-valgrind-warn-glyph {
          background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23f59e0b'><polygon points='8,2 15,14 1,14'/></svg>") no-repeat center center;
          background-size: 11px 11px;
        }
        @keyframes cmsPulseRed {
          from { background: rgba(239, 68, 68, 0.18); }
          to   { background: rgba(239, 68, 68, 0.36); }
        }
      `}</style>

      {/* Primary Debugger Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 bg-slate-900 border-b border-slate-800">
        {/* Left Action Group: Start/Stop & Step Controls */}
        <div className="flex items-center gap-1.5">
          {!isRunning && !isConnecting ? (
            <button
              type="button"
              onClick={onStartTrace}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition cursor-pointer"
              title="Compile & Start GDB Execution Trace"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Trace GDB</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onStopTrace}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm transition cursor-pointer"
              title="Stop Active Trace"
            >
              <Square className="w-3.5 h-3.5" />
              <span>{isConnecting ? "Connecting..." : "Stop"}</span>
            </button>
          )}

          <div className="h-4 w-px bg-slate-800 mx-1" />

          <button
            type="button"
            onClick={onStepPrev}
            disabled={totalSteps === 0 || stepIndex <= 0}
            className="p-1.5 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none text-slate-200 transition cursor-pointer"
            title="Step Backward"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          {!isPlaying ? (
            <button
              type="button"
              onClick={onPlay}
              disabled={totalSteps === 0}
              className="p-1.5 rounded-md bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-40 disabled:pointer-events-none text-white transition cursor-pointer"
              title="Auto-Play Execution Steps"
            >
              <Play className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              className="p-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white transition cursor-pointer"
              title="Pause Auto-Play"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={onStepNext}
            disabled={totalSteps === 0 || stepIndex >= totalSteps - 1}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none text-slate-200 text-xs font-medium transition cursor-pointer"
            title="Step Forward (F10)"
          >
            <SkipForward className="w-4 h-4" />
            <span className="hidden sm:inline text-[11px] text-slate-400">F10</span>
          </button>
        </div>

        {/* Right Action Group: Speed Slider & Valgrind Button */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 px-2.5 py-1 rounded-md"
            title="Auto-Play Step Interval (50ms - 1500ms)"
          >
            <Gauge className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="range"
              min={50}
              max={1500}
              step={50}
              value={playbackSpeedMs}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className="w-20 accent-sky-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
            />
            <span className="text-[11px] font-mono text-slate-300 w-12 text-right">
              {playbackSpeedMs}ms
            </span>
          </div>

          <button
            type="button"
            onClick={onRunValgrind}
            disabled={isAuditingValgrind}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-slate-950 shadow-sm transition cursor-pointer"
            title="Run Valgrind Memcheck XML Auditor"
          >
            {isAuditingValgrind ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5" />
            )}
            <span>Run Valgrind Audit</span>
          </button>
        </div>
      </div>

      {/* Time-Travel Step Scrubber Bar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-900/60 border-b border-slate-800/80 text-xs">
        <span className="font-mono text-slate-400 whitespace-nowrap">
          Step{" "}
          <strong className="text-sky-400">
            {totalSteps > 0 ? stepIndex + 1 : 0}
          </strong>{" "}
          / {totalSteps}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0, totalSteps - 1)}
          value={totalSteps > 0 ? stepIndex : 0}
          disabled={totalSteps === 0}
          onChange={(e) => onSeekTo(Number(e.target.value))}
          className="flex-1 accent-sky-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg disabled:opacity-40"
        />

        {activeLine && activeLine > 0 ? (
          <span className="px-2 py-0.5 rounded bg-sky-950/90 border border-sky-700/60 text-sky-300 font-mono text-[11px]">
            Line {activeLine}
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono text-[11px]">
            Idle
          </span>
        )}
      </div>

      {/* Monaco Editor Canvas */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          defaultLanguage="c"
          theme="vs-dark"
          value={code}
          onChange={(val) => onChange(val ?? "")}
          onMount={handleEditorMount}
          options={{
            fontSize: 13.5,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontLigatures: true,
            glyphMargin: true,
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            renderLineHighlight: "all",
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
};
