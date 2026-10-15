/**
 * frontend/src/hooks/useDebugSession.ts
 * Manages the WebSocket lifecycle (`ws://localhost:8080/ws/trace`),
 * time-travel frame history buffer, auto-play interval timer,
 * and REST Valgrind audit execution (`POST http://localhost:8080/api/analyze/memory`).
 * Guarantees zero stale state across runs.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  type DebugFrame,
  type ValgrindAuditResponse,
  type GraphEdge,
} from "../types/debug";

const WS_TRACE_URL =
  import.meta.env.VITE_WS_TRACE_URL || "ws://localhost:8080/ws/trace";
const REST_VALGRIND_URL =
  import.meta.env.VITE_REST_VALGRIND_URL ||
  "http://localhost:8080/api/analyze/memory";

export interface UseDebugSessionReturn {
  sessionId: number;
  frames: DebugFrame[];
  stepIndex: number;
  totalSteps: number;
  currentFrame: DebugFrame | null;
  isConnecting: boolean;
  isRunning: boolean;
  isPlaying: boolean;
  isAuditingValgrind: boolean;
  playbackSpeedMs: number;
  error: string | null;
  valgrindData: ValgrindAuditResponse | null;
  startTrace: (code: string, stdin?: string) => void;
  stepNext: () => void;
  stepPrev: () => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (index: number) => void;
  setPlaybackSpeedMs: (speedMs: number) => void;
  runValgrindAudit: (code: string, stdin?: string) => Promise<ValgrindAuditResponse | null>;
  clearValgrindData: () => void;
  resetSession: () => void;
  clearError: () => void;
}

function normalizeFrame(raw: Record<string, unknown>, fallbackStep: number): DebugFrame {
  const rawGraph = (raw.graph as Record<string, unknown>) || {};
  const rawEdges = Array.isArray(rawGraph.edges) ? rawGraph.edges : [];

  const normalizedEdges: GraphEdge[] = rawEdges.map((e: Record<string, unknown>) => ({
    source: String(e.source ?? e.from ?? ""),
    target: String(e.target ?? e.to ?? ""),
    from: String(e.from ?? e.source ?? ""),
    to: String(e.to ?? e.target ?? ""),
    label: String(e.label ?? ""),
    is_active: Boolean(e.is_active),
    is_directed: Boolean(e.is_directed),
  }));

  return {
    step: typeof raw.step === "number" ? raw.step : fallbackStep,
    line: typeof raw.line === "number" ? raw.line : 0,
    source_file: typeof raw.source_file === "string" ? raw.source_file : "target.c",
    call_stack: Array.isArray(raw.call_stack)
      ? (raw.call_stack as string[])
      : ["main"],
    arrays: Array.isArray(raw.arrays) ? (raw.arrays as DebugFrame["arrays"]) : [],
    graph: {
      nodes: Array.isArray(rawGraph.nodes)
        ? (rawGraph.nodes as DebugFrame["graph"]["nodes"])
        : [],
      edges: normalizedEdges,
      stack_pointers:
        rawGraph.stack_pointers && typeof rawGraph.stack_pointers === "object"
          ? (rawGraph.stack_pointers as Record<string, string>)
          : {},
      mode:
        rawGraph.mode === "abstract_graph" ? "abstract_graph" : "pointer_mesh",
    },
    stack_frames:
      raw.stack_frames && typeof raw.stack_frames === "object"
        ? (raw.stack_frames as DebugFrame["stack_frames"])
        : { locals: {} },
    status:
      raw.status === "completed" || raw.status === "error"
        ? raw.status
        : "running",
  };
}

export function useDebugSession(): UseDebugSessionReturn {
  const [sessionId, setSessionId] = useState<number>(1);
  const [frames, setFrames] = useState<DebugFrame[]>([]);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isAuditingValgrind, setIsAuditingValgrind] = useState<boolean>(false);
  const [playbackSpeedMs, setPlaybackSpeedMs] = useState<number>(450);
  const [error, setError] = useState<string | null>(null);
  const [valgrindData, setValgrindData] = useState<ValgrindAuditResponse | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (playIntervalRef.current !== null) {
        window.clearInterval(playIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (playIntervalRef.current !== null) {
      window.clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
    }

    if (!isPlaying) {
      return;
    }

    const clampedSpeed = Math.max(50, Math.min(1500, playbackSpeedMs));
    playIntervalRef.current = window.setInterval(() => {
      setStepIndex((prevIndex) => {
        if (prevIndex + 1 < frames.length) {
          return prevIndex + 1;
        }
        if (!isRunning) {
          setIsPlaying(false);
        }
        return prevIndex;
      });
    }, clampedSpeed);

    return () => {
      if (playIntervalRef.current !== null) {
        window.clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeedMs, frames.length, isRunning]);

  const stop = useCallback(() => {
    setIsPlaying(false);
    setIsConnecting(false);
    setIsRunning(false);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const clearValgrindData = useCallback(() => {
    setValgrindData(null);
  }, []);

  const resetSession = useCallback(() => {
    stop();
    setSessionId((prev) => prev + 1);
    setFrames([]);
    setStepIndex(0);
    setValgrindData(null);
    setError(null);
  }, [stop]);

  const startTrace = useCallback(
    (code: string, stdin: string = "") => {
      stop();
      // Hard flush of all state from any prior run
      setSessionId((prev) => prev + 1);
      setFrames([]);
      setStepIndex(0);
      setValgrindData(null);
      setError(null);
      setIsConnecting(true);

      try {
        const ws = new WebSocket(WS_TRACE_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          setIsConnecting(false);
          setIsRunning(true);
          ws.send(
            JSON.stringify({
              action: "start",
              code,
              stdin,
            })
          );
        };

        ws.onmessage = (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);

            if (payload.event === "compile_error") {
              setError(`Compilation Failed:\n${payload.stderr || "Unknown compiler error"}`);
              setIsRunning(false);
              setIsPlaying(false);
              return;
            }

            if (payload.event === "error") {
              setError(
                `${payload.error_type || "Runtime Error"}: ${
                  payload.detail || "Execution aborted."
                }`
              );
              setIsRunning(false);
              setIsPlaying(false);
              return;
            }

            if (payload.event === "completed" || payload.status === "completed") {
              setIsRunning(false);
              return;
            }

            if (typeof payload.line === "number") {
              setFrames((prev) => {
                const nextFrame = normalizeFrame(payload, prev.length + 1);
                return [...prev, nextFrame];
              });
            }
          } catch (parseErr) {
            setError(
              `Malformed WebSocket frame received: ${
                parseErr instanceof Error ? parseErr.message : String(parseErr)
              }`
            );
          }
        };

        ws.onerror = () => {
          setIsConnecting(false);
          setIsRunning(false);
          setIsPlaying(false);
          setError(
            `WebSocket error while communicating with ${WS_TRACE_URL}. Ensure the Docker container is running on port 8080.`
          );
        };

        ws.onclose = () => {
          setIsConnecting(false);
          setIsRunning(false);
        };
      } catch (err) {
        setIsConnecting(false);
        setIsRunning(false);
        setError(err instanceof Error ? err.message : "Failed to open WebSocket.");
      }
    },
    [stop]
  );

  const stepNext = useCallback(() => {
    setIsPlaying(false);
    setStepIndex((prev) => (prev + 1 < frames.length ? prev + 1 : prev));
  }, [frames.length]);

  const stepPrev = useCallback(() => {
    setIsPlaying(false);
    setStepIndex((prev) => (prev > 0 ? prev - 1 : 0));
  }, []);

  const play = useCallback(() => {
    if (frames.length === 0) return;
    setStepIndex((prev) => (prev >= frames.length - 1 ? 0 : prev));
    setIsPlaying(true);
  }, [frames.length]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const seekTo = useCallback(
    (index: number) => {
      if (frames.length === 0) return;
      const clamped = Math.max(0, Math.min(frames.length - 1, index));
      setStepIndex(clamped);
    },
    [frames.length]
  );

  const runValgrindAudit = useCallback(
    async (code: string, stdin: string = ""): Promise<ValgrindAuditResponse | null> => {
      // Immediately clear previous Valgrind report before sending HTTP request
      setIsAuditingValgrind(true);
      setValgrindData(null);
      setError(null);

      try {
        const response = await fetch(REST_VALGRIND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code, stdin }),
        });

        const data: ValgrindAuditResponse = await response.json();

        if (!response.ok || !data.success) {
          const errMsg =
            data.compilation_error ||
            data.runtime_error ||
            `Valgrind request failed with status ${response.status}`;
          setError(`Compilation / Valgrind Error:\n${errMsg}`);
          setValgrindData(data);
          return data;
        }

        setValgrindData(data);
        return data;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Network error while contacting Valgrind analyzer.";
        setError(`Failed to run Valgrind audit: ${message}`);
        return null;
      } finally {
        setIsAuditingValgrind(false);
      }
    },
    []
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const currentFrame = useMemo<DebugFrame | null>(() => {
    if (frames.length === 0) return null;
    return frames[Math.min(stepIndex, frames.length - 1)] ?? null;
  }, [frames, stepIndex]);

  return {
    sessionId,
    frames,
    stepIndex,
    totalSteps: frames.length,
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
    clearValgrindData,
    resetSession,
    clearError,
  };
}
