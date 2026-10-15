#!/usr/bin/env python3
"""
backend/src/debugger/gdb_engine.py

Algorithm-Agnostic DWARF/GDB-MI Introspection Engine for C-Memory-Studio.
Features:
  1. Multi-Frame Call Stack Harvesting: Inspects variables across all active user frames
     (from leaf function up to `main()`) so caller data structures never vanish during helper calls.
  2. Structural Graph Inference (Zero Hardcoded Struct Names):
     - Adjacency Lists: Any struct with an integer vertex count and a `Node **` / `Node *[]`
       pointing to self-referential list nodes containing a destination index and optional weight.
     - Adjacency Matrices: Any 2D array `T mat[V][V]` or `T **mat` (Floyd-Warshall, dense Dijkstra).
     - Edge Lists: Any struct array `Edge edges[E]` or `g->edge` containing `(u, v, [w])` tuples
       (Bellman-Ford, Kruskal).
  3. Generic Struct-Pointer & Struct-Value Dynamic Buffer Inspection:
     - Inspects any `Type **array` or `Type *array` by reflecting its DWARF `ptype` fields dynamically.
"""

import asyncio
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel, Field
from pygdbmi.gdbcontroller import GdbController

# ==============================================================================
# Configuration & Safety Limits
# ==============================================================================

TMPFS_ROOT = Path(os.getenv("TMPFS_PATH", "/sandbox/workspace"))
MAX_STEPS = 2000
SESSION_TIMEOUT_SEC = 30.0
STEP_INACTIVITY_TIMEOUT_SEC = 3.0
MAX_ARRAY_ELEMENTS = 256
MAX_STRUCT_BUFFER_ELEMENTS = 64
MAX_GRAPH_NODES = 32
# Treat typical C infinity sentinel constants (INT_MAX, 0x3f3f3f3f, 1e9, 99999) as ∞
INF_SENTINEL_VALUES = {2147483647, 1061109567, 1000000000, 999999999, 999999, 99999, 65535}
INT_MAX_THRESHOLD = 1000000000

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
FIXED_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s]*?)\s*\[(\d+)\]$")
FIXED_2D_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s]*?)\s*\[(\d+)\]\s*\[(\d+)\]$")
PTR_TYPE_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\*$")
FREE_CALL_RE = re.compile(
    r"\bfree(?:_[a-zA-Z0-9_]+)?\s*\(\s*([a-zA-Z_][a-zA-Z0-9_\->\.\[\]]*)\s*\)"
)

# ==============================================================================
# Heuristic Role Hints (Used Only to Rank Structural Candidates, Never Required)
# ==============================================================================

VERTEX_COUNT_HINTS = {"v", "V", "n", "N", "num_vertices", "num_nodes", "vertices", "nodes", "order", "nv"}
EDGE_COUNT_HINTS = {"e", "E", "m", "M", "num_edges", "edges_count", "ne"}
DEST_FIELD_HINTS = ("dest", "to", "target", "v", "vertex", "node", "neighbor", "adj", "id")
SRC_FIELD_HINTS = ("src", "from", "u", "source", "start")
WEIGHT_FIELD_HINTS = ("weight", "w", "cost", "dist", "distance", "len", "length", "val", "value", "priority")
DISTANCE_ARRAY_HINTS = ("dist", "d", "distance", "distances", "cost", "shortest", "dp")

STRUCT_CAPACITY_FIELDS = (
    "capacity", "cap", "max_size", "maxsize", "alloc", "allocated",
    "size", "len", "length", "count", "n", "V", "num_vertices", "num_nodes", "E", "num_edges"
)

STRUCT_INDEX_FIELDS = {
    "top", "front", "rear", "head", "tail", "idx", "index", "pos",
    "curr", "current", "min_idx", "max_idx", "smallest", "left", "right"
}

AUXILIARY_MAP_FIELD_NAMES = {
    "pos", "position", "positions", "indices", "index_map", "lookup", "rank", "visited", "in_heap", "in_queue"
}

NON_INDEX_SCALAR_NAMES = {
    "n", "len", "length", "size", "count", "capacity", "cap", "max_size", "maxsize",
    "num", "v_size", "arr_size", "V", "E", "d_u", "weight", "dist", "cost",
    "target", "key", "val", "value", "search", "x", "elem", "item", "needle",
    "tmp", "temp", "swap", "found", "res", "result", "ans", "ret", "flag", "sum", "max", "min"
}

INDEX_VAR_CANDIDATES = {
    "i", "j", "k", "u", "v", "src", "dest", "node", "curr_v", "next_v",
    "idx", "index", "min_idx", "max_idx", "pivot", "low", "high",
    "left", "right", "mid", "middle", "l", "r", "start", "end",
    "pos", "top", "front", "rear", "curr_idx", "smallest"
}

PRIMITIVE_TYPES = {
    "int", "long", "short", "char", "float", "double",
    "unsigned int", "unsigned long", "unsigned char", "unsigned short",
    "signed int", "signed long", "signed char", "signed short",
    "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "size_t", "ssize_t", "bool", "_Bool"
}

STDLIB_CALL_RE = re.compile(
    r"\b(malloc|calloc|realloc|free|printf|fprintf|sprintf|snprintf|scanf|fscanf|puts|putchar|getchar|memcpy|memmove|memset|memcmp|strlen|strcpy|strncpy|strcmp|exit|abort)\s*\("
)
USER_FUNC_CALL_RE = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(")
C_CONTROL_KEYWORDS = {"if", "for", "while", "switch", "return", "sizeof", "typeof"}

ATOMIC_HELPER_PREFIXES = (
    "create_", "new_", "init_", "alloc_", "make_",
    "swap_", "is_", "has_", "get_", "set_", "free_", "destroy_", "delete_", "print_"
)
ATOMIC_HELPER_NAMES = {
    "add_edge", "insert_edge", "min_heapify", "max_heapify", "heapify",
    "extract_min", "extract_max", "decrease_key", "increase_key",
    "push_heap", "pop_heap"
}


# ==============================================================================
# Pydantic Snapshot Schemas (Matches Frontend Contract)
# ==============================================================================

class ArraySnapshot(BaseModel):
    name: str
    type: str
    elements: List[Any]
    active_indices: Dict[str, int]


class GraphNode(BaseModel):
    id: str
    type: str
    label: str
    fields: Dict[str, Any]
    is_active: bool
    is_freed: bool = False
    pointers: List[str] = Field(default_factory=list)


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str
    is_active: bool = False
    is_directed: bool = False
    from_node: Optional[str] = Field(default=None, alias="from")
    to_node: Optional[str] = Field(default=None, alias="to")

    class Config:
        populate_by_name = True


class GraphSnapshot(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    stack_pointers: Dict[str, str] = Field(default_factory=dict)
    mode: str = "pointer_mesh"


class ExecutionSnapshot(BaseModel):
    step: int
    line: int
    source_file: str
    call_stack: List[str]
    arrays: List[ArraySnapshot]
    graph: GraphSnapshot
    stack_frames: Dict[str, Dict[str, Any]]
    status: str = "running"


# ==============================================================================
# Low-Level GDB Value Parsers
# ==============================================================================

def extract_hex_address(raw_val: str) -> Optional[str]:
    if not raw_val:
        return None
    match = HEX_ADDR_RE.search(raw_val)
    if not match:
        return None
    addr_str = match.group(1).lower()
    try:
        addr_int = int(addr_str, 16)
        if addr_int < 0x1000:
            return None
        return hex(addr_int)
    except ValueError:
        return None


def is_explicit_null(raw_val: str, is_known_pointer: bool = False) -> bool:
    val = raw_val.strip().lower()
    if val in {"0x0", "null", "(nil)"}:
        return True
    if is_known_pointer and val == "0":
        return True
    match = HEX_ADDR_RE.search(val)
    if match:
        try:
            return int(match.group(1), 16) == 0
        except ValueError:
            return False
    return False


def parse_scalar(val_str: str) -> Any:
    val_str = val_str.strip()
    if re.match(r"^-?\d+\s+'.*'$", val_str):
        return int(val_str.split()[0])
    try:
        if val_str.startswith(("0x", "0X")):
            addr_int = int(val_str.split()[0], 16)
            return hex(addr_int)
        if "." in val_str:
            return float(val_str)
        return int(val_str)
    except ValueError:
        return val_str


def is_infinity_like(val: Any) -> bool:
    if not isinstance(val, int):
        return False
    return val >= INT_MAX_THRESHOLD or val in INF_SENTINEL_VALUES


def format_distance_val(val: Any) -> Any:
    if is_infinity_like(val):
        return "∞"
    return val


def split_top_level_braces(inner: str) -> List[str]:
    """Splits a comma-separated GDB string at depth 0 (preserving nested `{...}`)."""
    tokens: List[str] = []
    current: List[str] = []
    depth = 0
    for ch in inner:
        if ch == "{":
            depth += 1
            current.append(ch)
        elif ch == "}":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            tok = "".join(current).strip()
            if tok:
                tokens.append(tok)
            current = []
        else:
            current.append(ch)
    if current:
        tok = "".join(current).strip()
        if tok:
            tokens.append(tok)
    return tokens


def parse_gdb_array(raw_val: str, max_elems: int = MAX_ARRAY_ELEMENTS) -> List[Any]:
    raw_val = raw_val.strip()
    if not (raw_val.startswith("{") and raw_val.endswith("}")):
        return []
    inner = raw_val[1:-1].strip()
    if not inner:
        return []

    elements: List[Any] = []
    parts = split_top_level_braces(inner)
    for part in parts:
        rep_match = re.match(r"^(.+?)\s*<repeats\s+(\d+)\s+times>$", part)
        if rep_match:
            base_val = parse_scalar(rep_match.group(1))
            count = min(int(rep_match.group(2)), max_elems)
            elements.extend([base_val] * count)
        elif part.startswith("{") and part.endswith("}"):
            elements.append(part)
        else:
            elements.append(parse_scalar(part))
    return elements[:max_elems]


def parse_gdb_struct_body(raw_val: str) -> Dict[str, str]:
    raw_val = raw_val.strip()
    brace_start = raw_val.find("{")
    brace_end = raw_val.rfind("}")
    if brace_start == -1 or brace_end == -1 or brace_end <= brace_start:
        return {}

    inner = raw_val[brace_start + 1 : brace_end].strip()
    if not inner:
        return {}

    fields: Dict[str, str] = {}
    for tok in split_top_level_braces(inner):
        if "=" in tok:
            k, v = tok.split("=", 1)
            fields[k.strip()] = v.strip()
    return fields


# ==============================================================================
# Algorithm-Agnostic GDB-MI Session Controller (`GDBTracer`)
# ==============================================================================

class GDBTracer:
    def __init__(
        self,
        binary_path: Path,
        source_path: Path,
        stdin_path: Optional[Path] = None,
    ):
        self.binary_path = binary_path
        self.source_path = source_path
        self.stdin_path = stdin_path
        self.gdb: Optional[GdbController] = None
        self.step_count = 0
        self.session_start_time = 0.0
        self.last_step_time = 0.0

        self._source_lines: List[str] = [""]
        if self.source_path.exists():
            self._source_lines.extend(
                self.source_path.read_text(encoding="utf-8", errors="replace").splitlines()
            )

        self._type_resolution_cache: Dict[str, Tuple[str, str]] = {}
        self._struct_field_types_cache: Dict[str, Dict[str, str]] = {}
        self._freed_addresses: Set[str] = set()
        self._last_valid_node_fields: Dict[str, Dict[str, Any]] = {}

        self._current_line: int = 0
        self._current_file: str = ""
        self._current_func: str = "main"

    def start(self) -> bool:
        now = time.monotonic()
        self.session_start_time = now
        self.last_step_time = now

        self.gdb = GdbController(
            command=[
                "gdb",
                "--nx",
                "--quiet",
                "--interpreter=mi3",
                str(self.binary_path),
            ],
            time_to_check_for_additional_output_sec=0.003,
        )
        self.gdb.get_gdb_response(timeout_sec=1.0, raise_error_on_timeout=False)

        for cmd in (
            "-gdb-set disable-randomization on",
            "-gdb-set print pretty off",
            "-gdb-set print address on",
            "-gdb-set print symbol off",
            "-gdb-set print elements 256",
            "-gdb-set print repeats 0",
            "-gdb-set confirm off",
            "-gdb-set pagination off",
        ):
            self._cmd(cmd)

        if self.stdin_path and self.stdin_path.exists():
            self._cmd(f'-gdb-set args < "{self.stdin_path}"')

        self._cmd("-break-insert main")
        run_res = self._cmd("-exec-run", timeout=STEP_INACTIVITY_TIMEOUT_SEC)
        return not self._update_stop_state(run_res)

    def close(self) -> None:
        if self.gdb:
            try:
                self.gdb.exit()
            except Exception:
                pass
            self.gdb = None

    def _check_budget(self) -> None:
        now = time.monotonic()
        if now - self.session_start_time > SESSION_TIMEOUT_SEC:
            raise TimeoutError(
                f"Trace session exceeded {SESSION_TIMEOUT_SEC:.0f}s maximum duration."
            )
        if self.step_count >= MAX_STEPS:
            raise RuntimeError(
                f"Trace session exceeded maximum limit of {MAX_STEPS} steps."
            )

    def _cmd(
        self, mi_command: str, timeout: float = STEP_INACTIVITY_TIMEOUT_SEC
    ) -> List[Dict[str, Any]]:
        self._check_budget()
        if not self.gdb:
            raise RuntimeError("GDB controller is not initialized.")
        self.last_step_time = time.monotonic()
        return self.gdb.write(
            mi_command,
            timeout_sec=timeout,
            raise_error_on_timeout=False,
        )

    def _eval_expr(self, expr: str) -> Optional[str]:
        responses = self._cmd(f'-data-evaluate-expression "{expr}"')
        for r in responses:
            if r.get("type") == "result":
                if r.get("message") == "done":
                    payload = r.get("payload", {})
                    if isinstance(payload, dict) and "value" in payload:
                        val = str(payload["value"])
                        if "Cannot access memory" in val or "<optimized out>" in val:
                            return None
                        return val
                elif r.get("message") == "error":
                    return None
        return None

    def _update_stop_state(self, responses: List[Dict[str, Any]]) -> bool:
        for r in responses:
            if r.get("type") == "notify" and r.get("message") == "stopped":
                payload = r.get("payload", {})
                if not isinstance(payload, dict):
                    continue

                reason = payload.get("reason", "")
                if reason in {"exited-normally", "exited", "exited-signalled"}:
                    return True

                if reason == "signal-received":
                    sig = payload.get("signal-name", "")
                    if sig != "SIGTRAP":
                        return True

                frame = payload.get("frame", {})
                if isinstance(frame, dict):
                    func = frame.get("func", "")
                    file_raw = frame.get("file") or frame.get("fullname") or ""
                    line_raw = frame.get("line", 0)

                    if func in {
                        "__libc_start_call_main",
                        "__libc_start_main",
                        "_start",
                        "exit",
                    }:
                        return True

                    self._current_func = func or "main"
                    self._current_file = Path(file_raw).name if file_raw else ""
                    try:
                        self._current_line = int(line_raw)
                    except (ValueError, TypeError):
                        self._current_line = 0
                return False
        return False

    def _record_pending_free_on_current_line(self) -> None:
        if 1 <= self._current_line < len(self._source_lines):
            src_line = self._source_lines[self._current_line].split("//")[0]
            for match in FREE_CALL_RE.finditer(src_line):
                ptr_expr = match.group(1).strip()
                raw_addr = self._eval_expr(ptr_expr)
                addr = extract_hex_address(raw_addr or "")
                if addr and self._is_valid_heap_or_data_address(addr):
                    self._freed_addresses.add(addr)

    def _is_declared_on_current_line(self, var_name: str, line_num: int) -> bool:
        if not (1 <= line_num < len(self._source_lines)):
            return False
        src_line = self._source_lines[line_num].split("//")[0].strip()
        if src_line.startswith("for ") or src_line.startswith("for("):
            return False
        decl_pattern = (
            rf"^(?:struct\s+[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z_][a-zA-Z0-9_]*)\s*\*?\s*"
            rf"\b{re.escape(var_name)}\s*="
        )
        return bool(re.search(decl_pattern, src_line))

    def _should_step_into_current_line(self) -> bool:
        if not (1 <= self._current_line < len(self._source_lines)):
            return False
        src_line = self._source_lines[self._current_line].split("//")[0].strip()
        if not src_line:
            return False

        if STDLIB_CALL_RE.search(src_line):
            return False

        user_calls: List[str] = []
        for match in USER_FUNC_CALL_RE.finditer(src_line):
            fn_name = match.group(1)
            if fn_name in C_CONTROL_KEYWORDS:
                continue
            user_calls.append(fn_name)

        if not user_calls:
            return False

        for fn_name in user_calls:
            low_fn = fn_name.lower()
            if low_fn in ATOMIC_HELPER_NAMES or low_fn.startswith(ATOMIC_HELPER_PREFIXES):
                continue
            return True

        return False

    def step_next_user_line(self) -> bool:
        self._check_budget()
        self._record_pending_free_on_current_line()

        mi_step_cmd = (
            "-exec-step" if self._should_step_into_current_line() else "-exec-next"
        )
        responses = self._cmd(mi_step_cmd)
        if self._update_stop_state(responses):
            return False

        for _ in range(4):
            if (
                self._current_file == self.source_path.name
                and self._current_line > 0
            ):
                return True

            if self._current_func in {
                "__libc_start_call_main",
                "__libc_start_main",
                "_start",
                "exit",
            }:
                return False

            fin_res = self._cmd("-exec-finish")
            if self._update_stop_state(fin_res):
                return False

        return (
            self._current_file == self.source_path.name
            and self._current_line > 0
        )

    def _resolve_type_info(self, raw_type: str) -> Tuple[str, str]:
        """
        Resolves any C type into `(category, target_c_type)`:
          - `("struct_ptr_array", "struct Node")` -> for `Node **` or `struct Node **`
          - `("primitive_ptr_array", "int")`      -> for `int **` (2D dynamic matrix)
          - `("struct_ptr", "struct stack_t")`    -> for `struct Node *`, `Graph *`, or pointer-typedef
          - `("struct_val", "struct stack_t")`    -> for `struct Node` by value
          - `("primitive_ptr", "int")`            -> for `int *`, `double *`
          - `("primitive", "int")`                -> for `int`, `size_t`
          - `("other", raw_type)`
        """
        clean = raw_type.replace("const", "").replace("volatile", "").strip()
        if clean in self._type_resolution_cache:
            return self._type_resolution_cache[clean]

        if clean in PRIMITIVE_TYPES:
            res = ("primitive", clean)
            self._type_resolution_cache[clean] = res
            return res

        if clean.endswith("**"):
            base_no_stars = clean.rstrip("*").strip()
            if base_no_stars in PRIMITIVE_TYPES:
                res = ("primitive_ptr_array", base_no_stars)
                self._type_resolution_cache[clean] = res
                return res
            base_kind, base_resolved = self._resolve_type_info(base_no_stars)
            if base_kind == "struct_val":
                res = ("struct_ptr_array", base_resolved)
                self._type_resolution_cache[clean] = res
                return res

        ptr_match = PTR_TYPE_RE.match(clean)
        if ptr_match:
            base = ptr_match.group(1).strip()
            if base in PRIMITIVE_TYPES:
                res = ("primitive_ptr", base)
                self._type_resolution_cache[clean] = res
                return res
            if base.startswith("struct ") and not base.endswith("*"):
                self._ensure_struct_field_types(base)
                res = ("struct_ptr", base)
                self._type_resolution_cache[clean] = res
                return res
            base_kind, base_resolved = self._resolve_type_info(base)
            if base_kind == "struct_val":
                res = ("struct_ptr", base_resolved)
                self._type_resolution_cache[clean] = res
                return res
            if base_kind == "struct_ptr":
                res = ("struct_ptr_array", base_resolved)
                self._type_resolution_cache[clean] = res
                return res
            if base_kind == "primitive_ptr":
                res = ("primitive_ptr_array", base_resolved)
                self._type_resolution_cache[clean] = res
                return res

        if clean.startswith("struct ") and not clean.endswith("*"):
            self._ensure_struct_field_types(clean)
            res = ("struct_val", clean)
            self._type_resolution_cache[clean] = res
            return res

        responses = self._cmd(f"ptype {clean}")
        full_console = "".join(
            r.get("payload", "") for r in responses if r.get("type") == "console"
        ).strip()

        if "type = struct" in full_console:
            header_match = re.search(
                r"type\s*=\s*(struct\s+[a-zA-Z_][a-zA-Z0-9_]*)", full_console
            )
            canonical_struct = (
                header_match.group(1).strip() if header_match else f"struct {clean}"
            )
            self._parse_and_cache_ptype_fields(canonical_struct, full_console)
            if canonical_struct != clean:
                self._struct_field_types_cache[clean] = (
                    self._struct_field_types_cache[canonical_struct]
                )

            brace_end = full_console.rfind("}")
            tail = full_console[brace_end + 1 :].strip() if brace_end != -1 else ""
            if "**" in tail:
                res = ("struct_ptr_array", canonical_struct)
            elif "*" in tail:
                res = ("struct_ptr", canonical_struct)
            else:
                res = ("struct_val", canonical_struct)
            self._type_resolution_cache[clean] = res
            return res

        res = ("other", clean)
        self._type_resolution_cache[clean] = res
        return res

    def _is_field_pointer_type(
        self, declared_f_type: str, f_name: str, f_val: str
    ) -> Tuple[bool, str, str]:
        clean_type = declared_f_type.replace("const", "").replace("volatile", "").strip()

        if clean_type:
            if clean_type in PRIMITIVE_TYPES and "*" not in clean_type:
                return (False, "primitive", clean_type)

            f_kind, f_target_type = self._resolve_type_info(clean_type)
            if f_kind in {"primitive_ptr", "primitive_ptr_array", "struct_ptr", "struct_ptr_array"} or "*" in clean_type:
                return (True, f_kind, f_target_type)
            if f_kind in {"primitive", "struct_val"}:
                return (False, f_kind, f_target_type)

        val_stripped = f_val.strip().lower()
        if val_stripped.startswith("0x") or HEX_ADDR_RE.search(val_stripped):
            return (True, "other", "")

        return (False, "primitive", clean_type or "int")

    def _collect_all_frame_variables(self) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Walks the call stack from leaf frame (level 0) up to `main()`.
        Returns `(call_stack_names, merged_variables_with_frame_level)`.
        Variables in frame 0 take precedence, while container pointers in outer frames
        (`main()`) are retained so graphs/matrices/heaps never flicker across function calls.
        """
        frame_res = self._cmd("-stack-list-frames")
        user_frames: List[Tuple[int, str, int]] = []
        call_stack: List[str] = []

        for r in frame_res:
            if r.get("type") == "result" and r.get("message") == "done":
                stack_payload = r.get("payload", {}).get("stack", [])
                for f_entry in stack_payload:
                    f = f_entry.get("frame", f_entry) if isinstance(f_entry, dict) else {}
                    func = f.get("func", "")
                    file_raw = f.get("file") or f.get("fullname") or ""
                    level = int(f.get("level", 0))
                    line = int(f.get("line", 0)) if "line" in f else 0
                    if func in {"__libc_start_call_main", "__libc_start_main", "_start"}:
                        continue
                    if Path(file_raw).name == self.source_path.name:
                        user_frames.append((level, func, line))
                break

        if not user_frames:
            user_frames = [(0, self._current_func, self._current_line)]

        call_stack = [fn for _, fn, _ in reversed(user_frames)]
        merged_vars: List[Dict[str, Any]] = []
        seen_var_names: Set[str] = set()

        for level, _, frame_line in user_frames:
            if level != 0:
                self._cmd(f"-stack-select-frame {level}")

            var_res = self._cmd("-stack-list-variables --simple-values")
            for r in var_res:
                if r.get("type") == "result" and r.get("message") == "done":
                    for v in r.get("payload", {}).get("variables", []):
                        v_name = v.get("name", "")
                        if not v_name or v_name in seen_var_names:
                            continue
                        if self._is_declared_on_current_line(v_name, frame_line):
                            continue
                        seen_var_names.add(v_name)
                        v_copy = dict(v)
                        v_copy["frame_level"] = level
                        merged_vars.append(v_copy)
                    break

        if len(user_frames) > 1:
            self._cmd("-stack-select-frame 0")

        return (call_stack, merged_vars)

    def inspect_state(self) -> Optional[ExecutionSnapshot]:
        self._check_budget()
        if (
            self._current_file != self.source_path.name
            or self._current_line <= 0
        ):
            return None

        call_stack, raw_vars = self._collect_all_frame_variables()

        locals_out: Dict[str, Any] = {}
        scalar_ints: Dict[str, int] = {}
        leaf_scalar_ints: Dict[str, int] = {}
        active_struct_ptrs: Dict[str, Tuple[str, str]] = {}
        raw_array_vars: List[Tuple[str, str, int, int]] = []        # (name, elem_type, len, frame_level)
        raw_2d_array_vars: List[Tuple[str, str, int, int, int]] = []  # (name, elem_type, rows, cols, frame_level)
        raw_ptr_vars: List[Tuple[str, str, str, int]] = []          # (name, elem_type, addr, frame_level)
        raw_2d_ptr_vars: List[Tuple[str, str, str, int]] = []       # (name, elem_type, addr, frame_level)

        # ----------------------------------------------------------------------
        # Pass 1: Classify all variables across active call stack frames
        # ----------------------------------------------------------------------
        for v in raw_vars:
            v_name = v.get("name", "")
            v_type = v.get("type", "").strip()
            v_val = v.get("value", "")
            f_level = int(v.get("frame_level", 0))

            if not v_name or not v_type:
                continue

            # Category A1: Fixed 2D stack array (`int [5][5]`)
            arr_2d_match = FIXED_2D_ARR_RE.match(v_type)
            if arr_2d_match:
                elem_type = arr_2d_match.group(1).strip()
                rows = min(int(arr_2d_match.group(2)), MAX_GRAPH_NODES)
                cols = min(int(arr_2d_match.group(3)), MAX_GRAPH_NODES)
                raw_2d_array_vars.append((v_name, elem_type, rows, cols, f_level))
                continue

            # Category A2: Fixed 1D stack array (`int [10]` or `struct Edge [8]`)
            arr_match = FIXED_ARR_RE.match(v_type)
            if arr_match:
                elem_type = arr_match.group(1).strip()
                arr_len = min(int(arr_match.group(2)), MAX_ARRAY_ELEMENTS)
                raw_array_vars.append((v_name, elem_type, arr_len, f_level))
                continue

            type_kind, resolved_target = self._resolve_type_info(v_type)

            # Category B: Struct pointer (`struct Node *`, `Graph *`, `MinHeap *`, `Edge *`)
            if type_kind == "struct_ptr":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if not addr:
                    continue

                if addr in self._freed_addresses and self._current_line > 0:
                    line_txt = (
                        self._source_lines[self._current_line - 1]
                        if self._current_line - 1 < len(self._source_lines)
                        else ""
                    )
                    if v_name in line_txt and (
                        "malloc" in line_txt
                        or "calloc" in line_txt
                        or "create_" in line_txt
                        or "init_" in line_txt
                        or "new_" in line_txt
                    ):
                        self._freed_addresses.discard(addr)

                active_struct_ptrs[v_name] = (addr, resolved_target)
                continue

            # Category C1: 2D Dynamic Matrix (`int **mat`)
            if type_kind == "primitive_ptr_array":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr:
                    raw_2d_ptr_vars.append((v_name, resolved_target, addr, f_level))
                continue

            # Category C2: 1D Primitive pointer (`int *dist`, `int *v`)
            if type_kind == "primitive_ptr":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr:
                    raw_ptr_vars.append((v_name, resolved_target, addr, f_level))
                continue

            # Category D: Struct by value (`struct Graph g;`)
            if type_kind == "struct_val":
                if f_level != 0:
                    self._cmd(f"-stack-select-frame {f_level}")
                addr_raw = self._eval_expr(f"&{v_name}")
                if f_level != 0:
                    self._cmd("-stack-select-frame 0")
                addr = extract_hex_address(addr_raw or "")
                if addr:
                    active_struct_ptrs[v_name] = (addr, resolved_target)
                    if f_level == 0:
                        locals_out[v_name] = addr
                continue

            # Category E: Scalar primitive (`int`, `size_t`, `float`, `char`)
            parsed_val = parse_scalar(v_val)
            if isinstance(parsed_val, int):
                scalar_ints[v_name] = parsed_val
                if f_level == 0:
                    leaf_scalar_ints[v_name] = parsed_val
                    locals_out[v_name] = format_distance_val(parsed_val)
            elif f_level == 0:
                locals_out[v_name] = parsed_val

        # ----------------------------------------------------------------------
        # Pass 2: Contiguous 1D Arrays (Primitive Arrays & Edge-List Struct Arrays)
        # ----------------------------------------------------------------------
        arrays_snapshot: List[ArraySnapshot] = []
        live_arrays_raw: Dict[str, List[Any]] = {}
        stack_edge_lists: List[Tuple[str, str, int, int]] = []  # (var_name, struct_type, count, frame_level)
        inferred_len = self._infer_dynamic_array_length(scalar_ints)

        for arr_name, elem_type, arr_len, f_level in raw_array_vars:
            elem_kind, elem_resolved = self._resolve_type_info(elem_type)
            if elem_kind == "struct_val":
                stack_edge_lists.append((arr_name, elem_resolved, arr_len, f_level))
                continue

            if f_level != 0:
                self._cmd(f"-stack-select-frame {f_level}")
            expr_val = self._eval_expr(arr_name)
            if f_level != 0:
                self._cmd("-stack-select-frame 0")

            if expr_val:
                raw_elements = parse_gdb_array(expr_val)
                live_arrays_raw[arr_name] = raw_elements
                elements = [format_distance_val(x) for x in raw_elements]
                active_idx = self._collect_active_indices(leaf_scalar_ints, len(elements))
                arrays_snapshot.append(
                    ArraySnapshot(
                        name=arr_name,
                        type=elem_type,
                        elements=elements,
                        active_indices=active_idx,
                    )
                )

        for ptr_name, elem_type, addr, _ in raw_ptr_vars:
            if (
                addr not in self._freed_addresses
                and inferred_len
                and 1 <= inferred_len <= MAX_ARRAY_ELEMENTS
                and self._is_valid_heap_or_data_address(addr)
            ):
                deref_expr = f"*({elem_type}[{inferred_len}]*)({addr})"
                expr_val = self._eval_expr(deref_expr)
                if expr_val:
                    raw_elements = parse_gdb_array(expr_val)
                    if raw_elements:
                        live_arrays_raw[ptr_name] = raw_elements
                        formatted_elements = [
                            format_distance_val(x) for x in raw_elements
                        ]
                        active_idx = self._collect_active_indices(
                            leaf_scalar_ints, len(formatted_elements)
                        )
                        arrays_snapshot.append(
                            ArraySnapshot(
                                name=ptr_name,
                                type=elem_type,
                                elements=formatted_elements,
                                active_indices=active_idx,
                            )
                        )

        # ----------------------------------------------------------------------
        # Pass 3: Generic Graph Inference (Adjacency List, 2D Matrix, or Edge List)
        # ----------------------------------------------------------------------
        abstract_graph, consumed_graph_addrs = self._infer_generic_mathematical_graph(
            active_struct_ptrs=active_struct_ptrs,
            raw_2d_array_vars=raw_2d_array_vars,
            raw_2d_ptr_vars=raw_2d_ptr_vars,
            stack_edge_lists=stack_edge_lists,
            scalar_ints=scalar_ints,
            leaf_scalar_ints=leaf_scalar_ints,
            live_arrays_raw=live_arrays_raw,
        )

        if abstract_graph is not None:
            graph_snapshot = abstract_graph
            _, embedded_arrays = self._crawl_pointer_graph(
                active_struct_ptrs,
                leaf_scalar_ints,
                excluded_addrs=consumed_graph_addrs,
            )
            arrays_snapshot.extend(embedded_arrays)
        else:
            graph_snapshot, embedded_arrays = self._crawl_pointer_graph(
                active_struct_ptrs,
                leaf_scalar_ints,
                excluded_addrs=set(),
            )
            arrays_snapshot.extend(embedded_arrays)

        self.step_count += 1
        return ExecutionSnapshot(
            step=self.step_count,
            line=self._current_line,
            source_file=self._current_file,
            call_stack=call_stack,
            arrays=arrays_snapshot,
            graph=graph_snapshot,
            stack_frames={"locals": locals_out},
            status="running",
        )

    # ==========================================================================
    # Generic Mathematical Graph Inference (Adjacency List / Matrix / Edge List)
    # ==========================================================================

    def _find_distance_array(
        self, num_v: int, live_arrays_raw: Dict[str, List[Any]]
    ) -> List[Any]:
        """Finds any active 1D integer array of length `num_v` representing vertex distances/costs."""
        for hint in DISTANCE_ARRAY_HINTS:
            if hint in live_arrays_raw and len(live_arrays_raw[hint]) >= num_v:
                return live_arrays_raw[hint]
        for arr_vals in live_arrays_raw.values():
            if len(arr_vals) == num_v:
                return arr_vals
        return []

    def _infer_generic_mathematical_graph(
        self,
        active_struct_ptrs: Dict[str, Tuple[str, str]],
        raw_2d_array_vars: List[Tuple[str, str, int, int, int]],
        raw_2d_ptr_vars: List[Tuple[str, str, str, int]],
        stack_edge_lists: List[Tuple[str, str, int, int]],
        scalar_ints: Dict[str, int],
        leaf_scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
    ) -> Tuple[Optional[GraphSnapshot], Set[str]]:
        """
        Inspects active data structures structurally to detect:
          1. Adjacency List Structs (any struct with a vertex count + pointer array of linked list nodes)
          2. Structs with an Edge Array (`g->edge` / `g->edges` for Bellman-Ford / Kruskal)
          3. 2D Adjacency Matrices (`int mat[V][V]` or `int **mat` for Floyd-Warshall / dense Dijkstra)
          4. Stack/Heap Edge List Arrays (`struct Edge edges[E]`)
        Returns `(GraphSnapshot, set_of_consumed_struct_addresses)`.
        """
        consumed_addrs: Set[str] = set()

        # ----------------------------------------------------------------------
        # Strategy 1: Structural Inspection of Active Struct Pointers
        # ----------------------------------------------------------------------
        for _, (s_addr, s_type) in active_struct_ptrs.items():
            if not self._is_valid_heap_or_data_address(s_addr) or s_addr in self._freed_addresses:
                continue

            f_types = self._ensure_struct_field_types(s_type)
            if not f_types:
                continue

            s_deref = self._eval_expr(f"*(({s_type} *){s_addr})")
            if not s_deref:
                continue
            s_fields = parse_gdb_struct_body(s_deref)

            # Collect integer scalar fields inside this struct
            int_fields: Dict[str, int] = {}
            for k, v_str in s_fields.items():
                decl_t = f_types.get(k, "")
                is_ptr, _, _ = self._is_field_pointer_type(decl_t, k, v_str)
                if not is_ptr:
                    val = parse_scalar(v_str)
                    if isinstance(val, int):
                        int_fields[k] = val

            # Find vertex count candidate inside struct (or fall back to frame scalar V/n)
            num_v = self._pick_vertex_count(int_fields, scalar_ints)
            if not num_v or not (1 <= num_v <= MAX_GRAPH_NODES):
                continue

            # Check every pointer field in `s_type` to see if it is:
            # (1A) A pointer-to-pointer adjacency list (`Node **`) where `Node` is self-referential
            # (1B) A pointer to a contiguous array of Edge structs (`Edge *`) where `Edge` has (u, v, [w])
            for f_name, f_decl_type in f_types.items():
                f_val_str = s_fields.get(f_name, "")
                f_addr = extract_hex_address(f_val_str)
                if not f_addr or not self._is_valid_heap_or_data_address(f_addr):
                    continue

                f_kind, f_target = self._resolve_type_info(f_decl_type)

                # Case 1A: `Node **` Adjacency List
                if f_kind == "struct_ptr_array" or "**" in f_decl_type:
                    node_s_type = (
                        f_target
                        if f_kind == "struct_ptr_array"
                        else f_decl_type.replace("*", "").strip()
                    )
                    if not node_s_type.startswith("struct "):
                        _, res_s = self._resolve_type_info(node_s_type)
                        node_s_type = res_s or f"struct {node_s_type}"

                    node_f_types = self._ensure_struct_field_types(node_s_type)
                    # A linked adjacency list node MUST have a self-referential pointer field (e.g. `next`)
                    next_field = self._find_self_ref_field(node_s_type, node_f_types)
                    if next_field:
                        snap = self._build_graph_from_adj_list(
                            num_v=num_v,
                            adj_array_addr=f_addr,
                            adj_node_type=node_s_type,
                            node_f_types=node_f_types,
                            next_field=next_field,
                            active_struct_ptrs=active_struct_ptrs,
                            leaf_scalar_ints=leaf_scalar_ints,
                            live_arrays_raw=live_arrays_raw,
                        )
                        if snap is not None:
                            consumed_addrs.add(s_addr)
                            return (snap, consumed_addrs)

                # Case 1B: `Edge *` Contiguous Edge Array inside a Graph struct (Bellman-Ford / Kruskal)
                if f_kind == "struct_ptr":
                    edge_s_type = f_target
                    edge_f_types = self._ensure_struct_field_types(edge_s_type)
                    if self._is_edge_triplet_struct(edge_s_type, edge_f_types):
                        num_e = self._pick_edge_count(int_fields, scalar_ints) or num_v * 2
                        snap = self._build_graph_from_edge_array(
                            num_v=num_v,
                            num_e=min(num_e, 64),
                            edge_array_expr=f"(({edge_s_type} *){f_addr})",
                            edge_f_types=edge_f_types,
                            leaf_scalar_ints=leaf_scalar_ints,
                            live_arrays_raw=live_arrays_raw,
                        )
                        if snap is not None:
                            consumed_addrs.add(s_addr)
                            return (snap, consumed_addrs)

        # ----------------------------------------------------------------------
        # Strategy 2: Top-Level Stack or Heap Edge List (`struct Edge edges[E]`)
        # ----------------------------------------------------------------------
        for arr_name, edge_s_type, arr_len, f_level in stack_edge_lists:
            edge_f_types = self._ensure_struct_field_types(edge_s_type)
            if self._is_edge_triplet_struct(edge_s_type, edge_f_types):
                num_v = self._pick_vertex_count({}, scalar_ints) or 0
                snap = self._build_graph_from_edge_array(
                    num_v=num_v,
                    num_e=min(arr_len, 64),
                    edge_array_expr=arr_name,
                    edge_f_types=edge_f_types,
                    leaf_scalar_ints=leaf_scalar_ints,
                    live_arrays_raw=live_arrays_raw,
                    frame_level=f_level,
                )
                if snap is not None:
                    return (snap, consumed_addrs)

        # ----------------------------------------------------------------------
        # Strategy 3: 2D Adjacency Matrix (`int mat[V][V]` or `int **mat`)
        # ----------------------------------------------------------------------
        for mat_name, elem_type, rows, cols, f_level in raw_2d_array_vars:
            if rows == cols and 2 <= rows <= 16 and elem_type in PRIMITIVE_TYPES:
                snap = self._build_graph_from_2d_matrix(
                    mat_name=mat_name,
                    dim=rows,
                    is_pointer_rows=False,
                    elem_type=elem_type,
                    frame_level=f_level,
                    leaf_scalar_ints=leaf_scalar_ints,
                    live_arrays_raw=live_arrays_raw,
                )
                if snap is not None:
                    return (snap, consumed_addrs)

        for mat_name, elem_type, addr, f_level in raw_2d_ptr_vars:
            dim = self._pick_vertex_count({}, scalar_ints)
            if (
                dim
                and 2 <= dim <= 16
                and self._is_valid_heap_or_data_address(addr)
                and addr not in self._freed_addresses
            ):
                snap = self._build_graph_from_2d_matrix(
                    mat_name=mat_name,
                    dim=dim,
                    is_pointer_rows=True,
                    elem_type=elem_type,
                    frame_level=f_level,
                    leaf_scalar_ints=leaf_scalar_ints,
                    live_arrays_raw=live_arrays_raw,
                    base_addr=addr,
                )
                if snap is not None:
                    return (snap, consumed_addrs)

        return (None, consumed_addrs)

    @staticmethod
    def _pick_vertex_count(struct_ints: Dict[str, int], frame_ints: Dict[str, int]) -> Optional[int]:
        for k in ("V", "num_vertices", "num_nodes", "vertices", "nodes", "n", "N", "nv"):
            if k in struct_ints and 1 <= struct_ints[k] <= MAX_GRAPH_NODES:
                return struct_ints[k]
        if struct_ints:
            first_v = next(iter(struct_ints.values()))
            if 1 <= first_v <= MAX_GRAPH_NODES:
                return first_v
        for k in ("V", "num_vertices", "num_nodes", "n", "N"):
            if k in frame_ints and 1 <= frame_ints[k] <= MAX_GRAPH_NODES:
                return frame_ints[k]
        return None

    @staticmethod
    def _pick_edge_count(struct_ints: Dict[str, int], frame_ints: Dict[str, int]) -> Optional[int]:
        for k in ("E", "num_edges", "edges_count", "m", "M", "ne"):
            if k in struct_ints and 1 <= struct_ints[k] <= 128:
                return struct_ints[k]
        for k in ("E", "num_edges", "m", "M"):
            if k in frame_ints and 1 <= frame_ints[k] <= 128:
                return frame_ints[k]
        return None

    def _find_self_ref_field(self, struct_type: str, field_types: Dict[str, str]) -> Optional[str]:
        short_name = struct_type.replace("struct ", "").strip()
        for f_name, f_decl in field_types.items():
            if "*" in f_decl and (short_name in f_decl or f_name in {"next", "link"}):
                return f_name
        return None

    def _is_edge_triplet_struct(self, struct_type: str, field_types: Dict[str, str]) -> bool:
        if self._find_self_ref_field(struct_type, field_types):
            return False
        int_cols = [
            k for k, t in field_types.items()
            if t.replace("const", "").strip() in PRIMITIVE_TYPES and "*" not in t
        ]
        return 2 <= len(int_cols) <= 4

    @staticmethod
    def _classify_adj_node_fields(field_types: Dict[str, str], next_field: str) -> Tuple[str, Optional[str]]:
        """
        Dynamically picks `(dest_field, weight_field)` from an adjacency list node's integer members.
        """
        scalar_fields = [
            k for k, t in field_types.items()
            if k != next_field and "*" not in t
        ]
        if not scalar_fields:
            return ("dest", None)

        dest_f = next(
            (k for hint in DEST_FIELD_HINTS for k in scalar_fields if k.lower() == hint),
            scalar_fields[0],
        )
        rem = [k for k in scalar_fields if k != dest_f]
        weight_f = next(
            (k for hint in WEIGHT_FIELD_HINTS for k in rem if k.lower() == hint),
            rem[0] if rem else None,
        )
        return (dest_f, weight_f)

    @staticmethod
    def _classify_edge_struct_fields(field_types: Dict[str, str]) -> Tuple[str, str, Optional[str]]:
        scalar_fields = [k for k, t in field_types.items() if "*" not in t]
        src_f = next(
            (k for hint in SRC_FIELD_HINTS for k in scalar_fields if k.lower() == hint),
            scalar_fields[0],
        )
        rem1 = [k for k in scalar_fields if k != src_f]
        dest_f = next(
            (k for hint in DEST_FIELD_HINTS for k in rem1 if k.lower() == hint),
            rem1[0] if rem1 else src_f,
        )
        rem2 = [k for k in rem1 if k != dest_f]
        weight_f = next(
            (k for hint in WEIGHT_FIELD_HINTS for k in rem2 if k.lower() == hint),
            rem2[0] if rem2 else None,
        )
        return (src_f, dest_f, weight_f)

    def _build_graph_from_adj_list(
        self,
        num_v: int,
        adj_array_addr: str,
        adj_node_type: str,
        node_f_types: Dict[str, str],
        next_field: str,
        active_struct_ptrs: Dict[str, Tuple[str, str]],
        leaf_scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
    ) -> Optional[GraphSnapshot]:
        adj_ptrs_raw = self._eval_expr(f"*(void *[{num_v}]*)({adj_array_addr})")
        if not adj_ptrs_raw:
            return None
        adj_head_addrs = parse_gdb_array(adj_ptrs_raw, max_elems=num_v)

        dest_field, weight_field = self._classify_adj_node_fields(node_f_types, next_field)

        # Check if any local pointer in the current frame points to an `adj_node_type` (like `crawl`, `curr`, `e`)
        active_edge_dest: Optional[int] = None
        for ptr_var, (p_addr, p_type) in active_struct_ptrs.items():
            if p_type == adj_node_type and self._is_valid_heap_or_data_address(p_addr):
                p_deref = self._eval_expr(f"*(({adj_node_type} *){p_addr})")
                if p_deref:
                    pf = parse_gdb_struct_body(p_deref)
                    d_val = parse_scalar(pf.get(dest_field, "-1"))
                    if isinstance(d_val, int) and 0 <= d_val < num_v:
                        active_edge_dest = d_val
                        break

        raw_directed_edges: List[Tuple[int, int, Any]] = []
        for u_idx, head_item in enumerate(adj_head_addrs):
            curr_addr = extract_hex_address(str(head_item))
            visited_chain: Set[str] = set()

            while (
                curr_addr
                and curr_addr not in visited_chain
                and len(visited_chain) < 32
                and self._is_valid_heap_or_data_address(curr_addr)
                and curr_addr not in self._freed_addresses
            ):
                visited_chain.add(curr_addr)
                node_deref = self._eval_expr(f"*(({adj_node_type} *){curr_addr})")
                if not node_deref:
                    break
                nf = parse_gdb_struct_body(node_deref)
                dest_v = parse_scalar(nf.get(dest_field, "-1"))
                weight_w = (
                    parse_scalar(nf.get(weight_field, "1"))
                    if weight_field and weight_field in nf
                    else None
                )
                if isinstance(dest_v, int) and 0 <= dest_v < num_v:
                    raw_directed_edges.append((u_idx, dest_v, weight_w))

                curr_addr = extract_hex_address(nf.get(next_field, ""))

        return self._assemble_abstract_graph_snapshot(
            num_v=num_v,
            raw_directed_edges=raw_directed_edges,
            leaf_scalar_ints=leaf_scalar_ints,
            live_arrays_raw=live_arrays_raw,
            active_edge_dest=active_edge_dest,
        )

    def _build_graph_from_edge_array(
        self,
        num_v: int,
        num_e: int,
        edge_array_expr: str,
        edge_f_types: Dict[str, str],
        leaf_scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
        frame_level: int = 0,
    ) -> Optional[GraphSnapshot]:
        src_f, dest_f, weight_f = self._classify_edge_struct_fields(edge_f_types)
        raw_directed_edges: List[Tuple[int, int, Any]] = []
        max_vert_seen = num_v - 1

        if frame_level != 0:
            self._cmd(f"-stack-select-frame {frame_level}")

        for idx in range(num_e):
            elem_str = self._eval_expr(f"({edge_array_expr})[{idx}]")
            if not elem_str:
                break
            ef = parse_gdb_struct_body(elem_str)
            u_val = parse_scalar(ef.get(src_f, "-1"))
            v_val = parse_scalar(ef.get(dest_f, "-1"))
            w_val = (
                parse_scalar(ef.get(weight_f, "1"))
                if weight_f and weight_f in ef
                else None
            )
            if (
                isinstance(u_val, int)
                and isinstance(v_val, int)
                and 0 <= u_val < MAX_GRAPH_NODES
                and 0 <= v_val < MAX_GRAPH_NODES
            ):
                if u_val == 0 and v_val == 0 and (w_val == 0 or w_val is None):
                    continue
                max_vert_seen = max(max_vert_seen, u_val, v_val)
                raw_directed_edges.append((u_val, v_val, w_val))

        if frame_level != 0:
            self._cmd("-stack-select-frame 0")

        final_v = max(num_v, max_vert_seen + 1)
        if final_v <= 0 or not raw_directed_edges:
            return None

        return self._assemble_abstract_graph_snapshot(
            num_v=min(final_v, MAX_GRAPH_NODES),
            raw_directed_edges=raw_directed_edges,
            leaf_scalar_ints=leaf_scalar_ints,
            live_arrays_raw=live_arrays_raw,
        )

    def _build_graph_from_2d_matrix(
        self,
        mat_name: str,
        dim: int,
        is_pointer_rows: bool,
        elem_type: str,
        frame_level: int,
        leaf_scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
        base_addr: str = "",
    ) -> Optional[GraphSnapshot]:
        raw_directed_edges: List[Tuple[int, int, Any]] = []

        if frame_level != 0:
            self._cmd(f"-stack-select-frame {frame_level}")

        if not is_pointer_rows:
            mat_raw = self._eval_expr(mat_name)
            if mat_raw:
                row_strs = parse_gdb_array(mat_raw, max_elems=dim)
                for i, r_str in enumerate(row_strs):
                    if isinstance(r_str, str) and r_str.startswith("{"):
                        row_vals = parse_gdb_array(r_str, max_elems=dim)
                        for j, cell_val in enumerate(row_vals):
                            if (
                                i != j
                                and isinstance(cell_val, (int, float))
                                and cell_val != 0
                                and not is_infinity_like(cell_val)
                            ):
                                raw_directed_edges.append((i, j, cell_val))
        else:
            row_ptrs_raw = self._eval_expr(f"*(void *[{dim}]*)({base_addr})")
            if row_ptrs_raw:
                row_ptrs = parse_gdb_array(row_ptrs_raw, max_elems=dim)
                for i, r_ptr in enumerate(row_ptrs):
                    r_addr = extract_hex_address(str(r_ptr))
                    if r_addr and self._is_valid_heap_or_data_address(r_addr):
                        row_str = self._eval_expr(f"*({elem_type}[{dim}]*)({r_addr})")
                        if row_str:
                            row_vals = parse_gdb_array(row_str, max_elems=dim)
                            for j, cell_val in enumerate(row_vals):
                                if (
                                    i != j
                                    and isinstance(cell_val, (int, float))
                                    and cell_val != 0
                                    and not is_infinity_like(cell_val)
                                ):
                                    raw_directed_edges.append((i, j, cell_val))

        if frame_level != 0:
            self._cmd("-stack-select-frame 0")

        if not raw_directed_edges:
            return None

        return self._assemble_abstract_graph_snapshot(
            num_v=dim,
            raw_directed_edges=raw_directed_edges,
            leaf_scalar_ints=leaf_scalar_ints,
            live_arrays_raw=live_arrays_raw,
        )

    def _assemble_abstract_graph_snapshot(
        self,
        num_v: int,
        raw_directed_edges: List[Tuple[int, int, Any]],
        leaf_scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
        active_edge_dest: Optional[int] = None,
    ) -> GraphSnapshot:
        dist_list = self._find_distance_array(num_v, live_arrays_raw)

        # Dynamically map any vertex-like scalar cursors in the active frame (`u`, `v`, `src`, `curr`, `i`, `j`, `k`)
        vertex_cursor_vars: List[str] = []
        for cand in ("src", "source", "start", "u", "v", "curr", "node", "k", "i", "j"):
            if cand in leaf_scalar_ints:
                val = leaf_scalar_ints[cand]
                if 0 <= val < num_v and len(vertex_cursor_vars) < 3:
                    vertex_cursor_vars.append(cand)

        nodes: List[GraphNode] = []
        stack_pointers_out: Dict[str, str] = {}

        for idx in range(num_v):
            node_id = f"node-{idx}"
            ptrs: List[str] = []

            for c_var in vertex_cursor_vars:
                if leaf_scalar_ints[c_var] == idx:
                    ptrs.append(c_var)
                    stack_pointers_out[c_var] = node_id

            if active_edge_dest == idx and not any(p in {"v", "dest", "to"} for p in ptrs):
                ptrs.append("target")

            raw_d = dist_list[idx] if idx < len(dist_list) else None
            formatted_d = format_distance_val(raw_d) if raw_d is not None else "—"

            fields_dict: Dict[str, Any] = {"vertex": idx}
            if raw_d is not None:
                fields_dict["dist"] = formatted_d
                fields_dict["status"] = "REACHED" if formatted_d != "∞" else "UNVISITED"

            label_str = (
                f"V{idx}\ndist: {formatted_d}"
                if raw_d is not None
                else f"Vertex {idx}"
            )

            nodes.append(
                GraphNode(
                    id=node_id,
                    type="Vertex",
                    label=label_str,
                    fields=fields_dict,
                    is_active=bool(ptrs),
                    is_freed=False,
                    pointers=ptrs,
                )
            )

        edge_lookup = {(u, v, str(w)) for u, v, w in raw_directed_edges}
        edges: List[GraphEdge] = []
        emitted_undirected: Set[Tuple[int, int, str]] = set()

        u_active = leaf_scalar_ints.get("u", leaf_scalar_ints.get("i"))
        v_active = leaf_scalar_ints.get("v", active_edge_dest if active_edge_dest is not None else leaf_scalar_ints.get("j"))

        for u_idx, v_idx, w_val in raw_directed_edges:
            w_str = str(w_val) if w_val is not None else ""
            is_symmetric = (v_idx, u_idx, w_str) in edge_lookup
            if is_symmetric:
                canon_pair = (min(u_idx, v_idx), max(u_idx, v_idx), w_str)
                if canon_pair in emitted_undirected:
                    continue
                emitted_undirected.add(canon_pair)

            is_active_edge = (
                isinstance(u_active, int)
                and isinstance(v_active, int)
                and (
                    (u_active == u_idx and v_active == v_idx)
                    or (is_symmetric and u_active == v_idx and v_active == u_idx)
                )
            )

            src_id = f"node-{u_idx}"
            tgt_id = f"node-{v_idx}"
            edge_label = f"w: {w_val}" if w_val is not None else ""

            edges.append(
                GraphEdge(
                    source=src_id,
                    target=tgt_id,
                    from_node=src_id,
                    to_node=tgt_id,
                    label=edge_label,
                    is_active=is_active_edge,
                    is_directed=not is_symmetric,
                )
            )

        return GraphSnapshot(
            nodes=nodes,
            edges=edges,
            stack_pointers=stack_pointers_out,
            mode="abstract_graph",
        )

    # ==========================================================================
    # Generic Struct-Pointer Array & ADT Buffer Inspector
    # ==========================================================================

    def _extract_struct_ptr_array_buffer(
        self,
        owner_name: str,
        field_name: str,
        array_base_addr: str,
        elem_struct_type: str,
        sister_scalars: Dict[str, int],
        frame_scalar_ints: Dict[str, int],
    ) -> Optional[ArraySnapshot]:
        """
        Generic DWARF-driven inspector for any `Type **array` inside a container struct.
        Dynamically reads whatever fields exist on `elem_struct_type` without relying on
        hardcoded struct names like `MinHeapNode`.
        """
        active_size = sister_scalars.get("size", sister_scalars.get("count", sister_scalars.get("len")))
        cap_size = self._infer_struct_buffer_length(sister_scalars)

        if isinstance(active_size, int) and 1 <= active_size <= MAX_STRUCT_BUFFER_ELEMENTS:
            count_to_read = active_size
        elif cap_size and 1 <= cap_size <= MAX_STRUCT_BUFFER_ELEMENTS:
            count_to_read = cap_size
        else:
            return None

        ptr_slice_raw = self._eval_expr(f"*(void *[{count_to_read}]*)({array_base_addr})")
        if not ptr_slice_raw:
            return None

        elem_addrs = parse_gdb_array(ptr_slice_raw, max_elems=count_to_read)
        if not elem_addrs:
            return None

        tuple_elements: List[Any] = []
        key_to_heap_idx: Dict[int, int] = {}

        for idx, raw_elem_ptr in enumerate(elem_addrs):
            elem_addr = extract_hex_address(str(raw_elem_ptr))
            if (
                not elem_addr
                or not self._is_valid_heap_or_data_address(elem_addr)
                or elem_addr in self._freed_addresses
            ):
                if active_size == 0:
                    break
                continue

            elem_deref = self._eval_expr(f"*(({elem_struct_type} *){elem_addr})")
            if not elem_deref:
                if active_size == 0:
                    break
                continue

            ef = parse_gdb_struct_body(elem_deref)
            if not ef:
                continue

            scalar_members = [
                (k, parse_scalar(v))
                for k, v in ef.items()
                if not extract_hex_address(v)
            ]

            if len(scalar_members) >= 2:
                # Pick identifier field first and priority/metric field second using hints or declaration order
                id_pair = next(
                    ((k, val) for hint in DEST_FIELD_HINTS for k, val in scalar_members if k.lower() == hint),
                    scalar_members[0],
                )
                rem_members = [(k, val) for k, val in scalar_members if k != id_pair[0]]
                metric_pair = next(
                    ((k, val) for hint in WEIGHT_FIELD_HINTS for k, val in rem_members if k.lower() == hint),
                    rem_members[0],
                )

                k_name, k_val = id_pair
                m_name, m_val = metric_pair
                m_formatted = format_distance_val(m_val)

                if isinstance(k_val, int):
                    key_to_heap_idx[k_val] = len(tuple_elements)

                tuple_elements.append(
                    {
                        "label": f"{k_name}: {k_val}, {m_name}: {m_formatted}",
                        "value": m_formatted,
                        "secondary": f"{k_name}={k_val}",
                    }
                )
            elif len(scalar_members) == 1:
                k_name, k_val = scalar_members[0]
                v_fmt = format_distance_val(k_val)
                tuple_elements.append(
                    {
                        "label": f"{k_name}: {v_fmt}",
                        "value": v_fmt,
                        "secondary": f"#{idx}",
                    }
                )

        if not tuple_elements:
            return None

        active_idx: Dict[str, int] = {"head": 0}
        if len(tuple_elements) > 1:
            active_idx["last"] = len(tuple_elements) - 1

        for cursor in ("smallest", "left", "right", "idx", "i", "top", "front", "rear"):
            if cursor in frame_scalar_ints:
                c_val = frame_scalar_ints[cursor]
                if 0 <= c_val < len(tuple_elements):
                    active_idx[cursor] = c_val

        if "v" in frame_scalar_ints:
            v_vert = frame_scalar_ints["v"]
            if v_vert in key_to_heap_idx:
                active_idx[f"v({v_vert})"] = key_to_heap_idx[v_vert]

        short_type = elem_struct_type.replace("struct ", "").strip() + "*"
        return ArraySnapshot(
            name=f"{owner_name}->{field_name} (Priority Queue)",
            type=short_type,
            elements=tuple_elements,
            active_indices=active_idx,
        )

    def _ensure_struct_field_types(self, struct_type: str) -> Dict[str, str]:
        if struct_type in self._struct_field_types_cache:
            return self._struct_field_types_cache[struct_type]

        responses = self._cmd(f"ptype {struct_type}")
        full_console = "".join(
            r.get("payload", "") for r in responses if r.get("type") == "console"
        )
        return self._parse_and_cache_ptype_fields(struct_type, full_console)

    def _parse_and_cache_ptype_fields(
        self, struct_type: str, ptype_output: str
    ) -> Dict[str, str]:
        field_map: Dict[str, str] = {}
        brace_start = ptype_output.find("{")
        brace_end = ptype_output.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            body = ptype_output[brace_start + 1 : brace_end]
            for raw_line in body.splitlines():
                line = raw_line.strip().rstrip(";")
                if not line:
                    continue
                m = re.match(
                    r"^(.+?[\s\*]+)([a-zA-Z_][a-zA-Z0-9_]*(\[\d+\])?)$", line
                )
                if m:
                    f_type = m.group(1).strip()
                    f_name = m.group(2).split("[")[0].strip()
                    field_map[f_name] = f_type

        self._struct_field_types_cache[struct_type] = field_map
        return field_map

    @staticmethod
    def _is_valid_heap_or_data_address(addr: str) -> bool:
        try:
            val = int(addr, 16)
        except ValueError:
            return False
        if val < 0x402000:
            return False
        if 0x7f0000000000 <= val < 0x7ffffff00000:
            return False
        return True

    def _is_tcache_poisoned(self, addr: str, raw_fields: Dict[str, str]) -> bool:
        if addr in self._freed_addresses:
            return True
        try:
            addr_int = int(addr, 16)
            expected_safe_link_base = addr_int >> 12
            first_val_str = next(iter(raw_fields.values()), "")
            first_val = parse_scalar(first_val_str)
            if isinstance(first_val, int) and first_val == expected_safe_link_base:
                self._freed_addresses.add(addr)
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def _infer_struct_buffer_length(sister_scalars: Dict[str, int]) -> Optional[int]:
        for field_key in STRUCT_CAPACITY_FIELDS:
            if field_key in sister_scalars:
                val = sister_scalars[field_key]
                if 1 <= val <= 4096:
                    return min(val, MAX_STRUCT_BUFFER_ELEMENTS)

        for k, val in sister_scalars.items():
            if k.lower().endswith(("_cap", "_capacity", "_size", "_len", "_count")):
                if 1 <= val <= 4096:
                    return min(val, MAX_STRUCT_BUFFER_ELEMENTS)

        for cursor_key in ("top", "rear", "tail"):
            if cursor_key in sister_scalars:
                c_val = sister_scalars[cursor_key]
                if 0 <= c_val < MAX_STRUCT_BUFFER_ELEMENTS:
                    return c_val + 1

        return None

    def _crawl_pointer_graph(
        self,
        active_struct_ptrs: Dict[str, Tuple[str, str]],
        frame_scalar_ints: Dict[str, int],
        excluded_addrs: Set[str],
    ) -> Tuple[GraphSnapshot, List[ArraySnapshot]]:
        visited_addrs: Set[str] = set(excluded_addrs)
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        primary_embedded_arrays: List[ArraySnapshot] = []
        auxiliary_embedded_arrays: List[ArraySnapshot] = []
        seen_edges: Set[Tuple[str, str, str]] = set()
        seen_embedded_buffers: Set[str] = set()

        addr_to_ptr_names: Dict[str, List[str]] = {}
        stack_pointers_out: Dict[str, str] = {}
        valid_seeds: List[Tuple[str, str, str]] = []

        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if addr in excluded_addrs:
                continue
            if self._is_valid_heap_or_data_address(addr):
                stack_pointers_out[ptr_name] = addr
                addr_to_ptr_names.setdefault(addr, []).append(ptr_name)
                valid_seeds.append((addr, s_type, ptr_name))

        queue: List[Tuple[str, str, str]] = list(valid_seeds)

        while queue and len(visited_addrs) < MAX_GRAPH_NODES:
            addr, struct_type, owner_name = queue.pop(0)
            if not addr or addr in visited_addrs:
                continue

            deref_str = self._eval_expr(f"*(({struct_type} *){addr})")
            if not deref_str:
                continue

            raw_fields = parse_gdb_struct_body(deref_str)
            if not raw_fields:
                continue

            visited_addrs.add(addr)
            field_types = self._ensure_struct_field_types(struct_type)
            is_freed = self._is_tcache_poisoned(addr, raw_fields)
            pointing_vars = addr_to_ptr_names.get(addr, [])

            if is_freed:
                last_known = self._last_valid_node_fields.get(addr, {})
                freed_fields: Dict[str, Any] = (
                    dict(last_known) if last_known else {"status": "FREED (tcache)"}
                )
                nodes.append(
                    GraphNode(
                        id=addr,
                        type=struct_type,
                        label="FREED",
                        fields=freed_fields,
                        is_active=bool(pointing_vars),
                        is_freed=True,
                        pointers=pointing_vars,
                    )
                )
                continue

            sister_scalars: Dict[str, int] = {}
            for f_name, f_val in raw_fields.items():
                declared_f_type = field_types.get(f_name, "").strip()
                is_ptr, _, _ = self._is_field_pointer_type(
                    declared_f_type, f_name, f_val
                )
                if not is_ptr and not f_val.startswith("{"):
                    parsed = parse_scalar(f_val)
                    if isinstance(parsed, int):
                        sister_scalars[f_name] = parsed

            node_fields: Dict[str, Any] = {}
            node_label: Optional[str] = None

            for f_name, f_val in raw_fields.items():
                declared_f_type = field_types.get(f_name, "").strip()

                if f_val.startswith("{") and f_val.endswith("}"):
                    sub_items = parse_gdb_array(
                        f_val, max_elems=MAX_STRUCT_BUFFER_ELEMENTS
                    )
                    node_fields[f_name] = sub_items
                    first_addr = (
                        extract_hex_address(str(sub_items[0])) if sub_items else None
                    )
                    if first_addr:
                        target_s_type = (
                            declared_f_type.rstrip("*").strip()
                            if "*" in declared_f_type
                            else struct_type
                        )
                        for idx, item in enumerate(sub_items):
                            sub_addr = extract_hex_address(str(item))
                            if sub_addr and self._is_valid_heap_or_data_address(
                                sub_addr
                            ):
                                edge_label = f"{f_name}[{idx}]"
                                edge_key = (addr, sub_addr, edge_label)
                                if edge_key not in seen_edges:
                                    seen_edges.add(edge_key)
                                    edges.append(
                                        GraphEdge(
                                            source=addr,
                                            target=sub_addr,
                                            from_node=addr,
                                            to_node=sub_addr,
                                            label=edge_label,
                                        )
                                    )
                                if sub_addr not in visited_addrs:
                                    queue.append(
                                        (
                                            sub_addr,
                                            target_s_type,
                                            f"{owner_name}->{f_name}[{idx}]",
                                        )
                                    )
                    elif sub_items:
                        active_idx = self._collect_struct_buffer_indices(
                            sister_scalars, frame_scalar_ints, len(sub_items)
                        )
                        primary_embedded_arrays.append(
                            ArraySnapshot(
                                name=f"{owner_name}->{f_name}",
                                type="int",
                                elements=[format_distance_val(x) for x in sub_items],
                                active_indices=active_idx,
                            )
                        )
                    continue

                is_ptr_field, f_kind, f_target_type = self._is_field_pointer_type(
                    declared_f_type, f_name, f_val
                )

                if is_ptr_field:
                    target_addr = extract_hex_address(f_val)
                    if is_explicit_null(f_val, is_known_pointer=True) or not target_addr:
                        node_fields[f_name] = "NULL"
                        continue

                    node_fields[f_name] = target_addr
                    if not self._is_valid_heap_or_data_address(target_addr):
                        continue

                    if (
                        (f_kind == "struct_ptr_array" or "**" in declared_f_type)
                        and target_addr not in self._freed_addresses
                    ):
                        elem_struct = (
                            f_target_type
                            if f_kind == "struct_ptr_array"
                            else declared_f_type.replace("*", "").strip()
                        )
                        if not elem_struct.startswith("struct "):
                            _, res_s = self._resolve_type_info(elem_struct)
                            elem_struct = res_s or f"struct {elem_struct}"

                        pq_snap = self._extract_struct_ptr_array_buffer(
                            owner_name=owner_name,
                            field_name=f_name,
                            array_base_addr=target_addr,
                            elem_struct_type=elem_struct,
                            sister_scalars=sister_scalars,
                            frame_scalar_ints=frame_scalar_ints,
                        )
                        if pq_snap is not None:
                            primary_embedded_arrays.append(pq_snap)
                        continue

                    is_primitive_buffer = (
                        f_kind == "primitive_ptr"
                        and "**" not in declared_f_type
                    )

                    if is_primitive_buffer and target_addr not in self._freed_addresses:
                        elem_c_type = f_target_type if f_kind == "primitive_ptr" else "int"
                        buf_len = self._infer_struct_buffer_length(sister_scalars)
                        if buf_len and 1 <= buf_len <= MAX_STRUCT_BUFFER_ELEMENTS:
                            deref_buf_expr = (
                                f"*({elem_c_type}[{buf_len}]*)({target_addr})"
                            )
                            buf_val_str = self._eval_expr(deref_buf_expr)
                            if buf_val_str:
                                elements = [
                                    format_distance_val(x)
                                    for x in parse_gdb_array(
                                        buf_val_str,
                                        max_elems=MAX_STRUCT_BUFFER_ELEMENTS,
                                    )
                                ]
                                if elements:
                                    active_idx = self._collect_struct_buffer_indices(
                                        sister_scalars,
                                        frame_scalar_ints,
                                        len(elements),
                                    )
                                    is_aux_map = f_name.lower() in AUXILIARY_MAP_FIELD_NAMES
                                    arr_display_name = (
                                        f"{owner_name}->{f_name} (Reverse Index Map)"
                                        if is_aux_map
                                        else f"{owner_name}->{f_name}"
                                    )
                                    snap_obj = ArraySnapshot(
                                        name=arr_display_name,
                                        type=elem_c_type,
                                        elements=elements,
                                        active_indices=active_idx,
                                    )
                                    if is_aux_map:
                                        auxiliary_embedded_arrays.append(snap_obj)
                                    else:
                                        primary_embedded_arrays.append(snap_obj)

                                    if target_addr not in seen_embedded_buffers:
                                        seen_embedded_buffers.add(target_addr)
                                        preview = ", ".join(
                                            str(x) for x in elements[:4]
                                        )
                                        if len(elements) > 4:
                                            preview += ", ..."
                                        nodes.append(
                                            GraphNode(
                                                id=target_addr,
                                                type=f"{elem_c_type}[{buf_len}]",
                                                label=f"[{preview}]",
                                                fields={
                                                    "buffer": f"[{preview}]",
                                                    "length": len(elements),
                                                },
                                                is_active=False,
                                                is_freed=False,
                                                pointers=[f"{owner_name}->{f_name}"],
                                            )
                                        )
                                    edge_key = (addr, target_addr, f_name)
                                    if edge_key not in seen_edges:
                                        seen_edges.add(edge_key)
                                        edges.append(
                                            GraphEdge(
                                                source=addr,
                                                target=target_addr,
                                                from_node=addr,
                                                to_node=target_addr,
                                                label=f_name,
                                            )
                                        )
                        continue

                    target_s_type = (
                        f_target_type
                        if f_kind == "struct_ptr"
                        else (
                            declared_f_type.rstrip("*").strip()
                            if "*" in declared_f_type
                            else struct_type
                        )
                    )
                    edge_key = (addr, target_addr, f_name)
                    if edge_key not in seen_edges:
                        seen_edges.add(edge_key)
                        edges.append(
                            GraphEdge(
                                source=addr,
                                target=target_addr,
                                from_node=addr,
                                to_node=target_addr,
                                label=f_name,
                            )
                        )
                    if target_addr not in visited_addrs:
                        queue.append(
                            (target_addr, target_s_type, f"{owner_name}->{f_name}")
                        )
                    continue

                parsed_scalar = format_distance_val(parse_scalar(f_val))
                node_fields[f_name] = parsed_scalar
                if node_label is None:
                    node_label = f"{f_name}: {parsed_scalar}"

            if node_label is None:
                node_label = str(next(iter(node_fields.values()), addr[-4:]))

            self._last_valid_node_fields[addr] = dict(node_fields)

            nodes.append(
                GraphNode(
                    id=addr,
                    type=struct_type,
                    label=node_label,
                    fields=node_fields,
                    is_active=bool(pointing_vars),
                    is_freed=False,
                    pointers=pointing_vars,
                )
            )

        all_embedded = primary_embedded_arrays + auxiliary_embedded_arrays

        return (
            GraphSnapshot(
                nodes=nodes,
                edges=edges,
                stack_pointers=stack_pointers_out,
                mode="pointer_mesh",
            ),
            all_embedded,
        )

    def _collect_struct_buffer_indices(
        self,
        sister_scalars: Dict[str, int],
        frame_scalar_ints: Dict[str, int],
        array_len: int,
    ) -> Dict[str, int]:
        active: Dict[str, int] = {}

        for s_name, s_val in sister_scalars.items():
            low_name = s_name.lower()
            if low_name in STRUCT_INDEX_FIELDS or low_name.endswith(
                ("_idx", "_index", "_pos")
            ):
                if -1 <= s_val <= array_len:
                    active[s_name] = s_val

        frame_indices = self._collect_active_indices(frame_scalar_ints, array_len)
        for k, v in frame_indices.items():
            if k not in active:
                active[k] = v

        return active

    def _infer_dynamic_array_length(self, scalar_ints: Dict[str, int]) -> Optional[int]:
        priority_names = ["n", "V", "len", "length", "size", "count", "capacity", "num"]
        for name in priority_names:
            if name in scalar_ints:
                val = scalar_ints[name]
                if 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val
        for name, val in scalar_ints.items():
            if name in VERTEX_COUNT_HINTS or name.lower().endswith(
                ("_len", "_size", "_count", "_vertices", "_nodes")
            ):
                if 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val
        return None

    def _collect_active_indices(
        self, scalar_ints: Dict[str, int], array_len: int
    ) -> Dict[str, int]:
        active: Dict[str, int] = {}
        for var_name, val in scalar_ints.items():
            if var_name in {"V", "N", "E", "M"}:
                continue
            low_name = var_name.lower()

            if low_name in NON_INDEX_SCALAR_NAMES or low_name.endswith(
                ("_len", "_size", "_count", "_cap", "_val", "_target", "_key")
            ):
                continue

            is_explicit_idx = (
                low_name in INDEX_VAR_CANDIDATES
                or low_name.endswith(("_idx", "_index", "_pos", "_ptr"))
            )

            if is_explicit_idx:
                if -1 <= val <= array_len:
                    active[var_name] = val
            else:
                if 0 <= val < array_len:
                    active[var_name] = val

        return active


# ==============================================================================
# Compilation & Worker Runner Functions
# ==============================================================================

def compile_c_source(
    source_code: str, workdir: Path = TMPFS_ROOT
) -> Tuple[bool, Path, Path, str]:
    workdir.mkdir(parents=True, exist_ok=True)
    source_path = workdir / "target.c"
    binary_path = workdir / "target"

    source_path.write_text(source_code, encoding="utf-8")

    compile_cmd = [
        "gcc",
        "-g3",
        "-O0",
        "-fno-inline",
        "-fno-omit-frame-pointer",
        "-no-pie",
        "-Wall",
        "-o",
        str(binary_path),
        str(source_path),
    ]

    proc = subprocess.run(
        compile_cmd,
        capture_output=True,
        text=True,
        timeout=5.0,
    )

    if proc.returncode != 0:
        return (False, binary_path, source_path, proc.stderr)

    return (True, binary_path, source_path, proc.stderr)


def run_trace_session(
    binary_path: Path,
    source_path: Path,
    stdin_path: Optional[Path],
    snapshot_queue: asyncio.Queue,
    loop: asyncio.AbstractEventLoop,
) -> None:
    tracer = GDBTracer(
        binary_path=binary_path,
        source_path=source_path,
        stdin_path=stdin_path,
    )

    def emit(payload: Dict[str, Any]) -> None:
        asyncio.run_coroutine_threadsafe(snapshot_queue.put(payload), loop).result()

    try:
        reached_main = tracer.start()
        if reached_main:
            initial_snap = tracer.inspect_state()
            if initial_snap:
                emit(initial_snap.model_dump(by_alias=True))

            while True:
                alive = tracer.step_next_user_line()
                if not alive:
                    break

                snap = tracer.inspect_state()
                if snap:
                    emit(snap.model_dump(by_alias=True))

        emit({"event": "completed", "status": "completed", "total_steps": tracer.step_count})

    except TimeoutError as exc:
        emit({"event": "error", "error_type": "TimeoutError", "detail": str(exc)})
    except RuntimeError as exc:
        emit({"event": "error", "error_type": "StepLimitExceeded", "detail": str(exc)})
    except Exception as exc:
        emit({"event": "error", "error_type": "InternalTracerError", "detail": str(exc)})
    finally:
        tracer.close()
        asyncio.run_coroutine_threadsafe(snapshot_queue.put(None), loop).result()
