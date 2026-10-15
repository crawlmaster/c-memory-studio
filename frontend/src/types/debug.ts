/**
 * frontend/src/types/debug.ts
 * Complete TypeScript contracts for the WebSocket GDB execution tracer
 * and the REST Valgrind Memcheck heap auditor.
 */

export interface ArrayData {
  name: string;
  type?: string;
  elements: Array<number | string>;
  active_indices: Record<string, number>;
}

export interface GraphNode {
  id: string;
  type?: string;
  label?: string;
  fields: Record<string, number | string | null>;
  is_active: boolean;
  is_freed?: boolean;
  pointers?: string[];
}

export interface GraphEdge {
  /** Normalized source address (supports both `source` and legacy `from`) */
  source?: string;
  from?: string;
  /** Normalized target address (supports both `target` and legacy `to`) */
  target?: string;
  to?: string;
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stack_pointers?: Record<string, string>;
}

export interface DebugFrame {
  step?: number;
  line: number;
  source_file?: string;
  call_stack?: string[];
  arrays: ArrayData[];
  graph: GraphData;
  stack_frames?: {
    locals: Record<string, number | string>;
  };
  status?: "running" | "completed" | "error";
}

export type MemoryBlockState =
  | "DEFINITELY_LOST"
  | "INDIRECTLY_LOST"
  | "POSSIBLY_LOST"
  | "STILL_REACHABLE"
  | "INVALID_ACCESS"
  | "INVALID_FREE"
  | "UNINITIALIZED_READ"
  | "FREED_CLEAN";

export interface SourceLocation {
  file: string;
  function: string;
  line: number;
}

export interface MemoryBlock {
  id: string;
  address: string;
  size_bytes: number;
  block_count: number;
  state: MemoryBlockState;
  allocated_at?: SourceLocation;
  detected_at?: SourceLocation;
  description: string;
}

export interface MemorySummary {
  total_allocated_bytes: number;
  total_freed_bytes: number;
  leaked_bytes: number;
  leak_count: number;
  has_fatal_errors: boolean;
  exit_code: number;
  signal?: string | null;
}

export interface ValgrindAuditResponse {
  success: boolean;
  compilation_error?: string;
  runtime_error?: string;
  summary?: MemorySummary;
  blocks?: MemoryBlock[];
}

export interface HighlightTarget {
  line: number;
  type: "execution" | "warning" | "error";
  message?: string;
  timestamp: number;
}
