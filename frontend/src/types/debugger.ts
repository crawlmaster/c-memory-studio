/**
 * frontend/src/types/debugger.ts
 * Purely structural DWARF data contracts for C-Memory-Studio.
 * Free of legacy aliases (`from`/`to`) and redundant pointer maps.
 */

export type CompoundArrayElement = {
  fields: Record<string, number | string>;
  address?: string;
};

export type ArrayElement = number | string | CompoundArrayElement;

export interface ArraySnapshot {
  name: string;
  type: string;
  kind?: "array" | "matrix";
  dimensions?: number[];
  rows?: Array<Array<number | string>>;
  element_type?: string;
  is_compound?: boolean;
  capacity?: number;
  elements: ArrayElement[];
  active_indices: Record<string, number>;
}

export interface GraphNode {
  id: string;
  label?: string;
  type?: string;
  c_type?: string;
  fields: Record<string, number | string>;
  pointers?: string[]; // Stack pointer badges: ["head", "curr", "s"]
  is_freed?: boolean;
  is_active?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExecutionStepFrame {
  step: number;
  line: number;
  source_file: string;
  call_stack: string[];
  arrays: ArraySnapshot[];
  graph: GraphData;
  stack_frames: {
    locals: Record<string, number | string>;
  };
  status: "running" | "completed" | "error";
}

// Type aliases for backward compatibility with existing component props
export type ArrayData = ArraySnapshot;
export type DebugFrame = ExecutionStepFrame;

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
  total_alloc_calls?: number;
  total_free_calls?: number;
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
