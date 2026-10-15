#!/usr/bin/env python3
"""
backend/src/debugger/gdb_engine.py

High-performance GDB/MI Execution Tracer, Mathematical Graph Extractor,
ADT Container Inspector & Recursive Heap Mesh Crawler.
Features:
  - Increased step budget (`MAX_STEPS = 2000`, `SESSION_TIMEOUT_SEC = 30.0`).
  - Smart atomic stepping (`-exec-next`) over micro-helpers (`new_*`, `create_*`, `swap_*`,
    `is_*`, `add_edge`, `min_heapify`, `extract_min`, `decrease_key`, `free_*`) so tracing
    focuses on core algorithmic loops (`main`, `dijkstra`, `bfs`, `dfs`, etc.).
  - Mathematical Graph Adjacency List Detector: automatically detects `Graph` structs
    containing `(V, adj)` and emits abstract vertices (`node-0` .. `node-(V-1)`) with
    live `dist[v]` (`∞` for `INT_MAX`), PQ status (`IN_PQ` vs `SETTLED`), weighted edges
    (`w: 9`), and active relaxation pointers (`u ↓`, `v ↓`, `src ↓`).
  - Persistent Graph Root Cache across stack frames to eliminate visual flickering.
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
MAX_STEPS = 2000                 # Increased from 500 to 2000 for graph/heap algorithms
SESSION_TIMEOUT_SEC = 30.0       # Increased to 30.0s
STEP_INACTIVITY_TIMEOUT_SEC = 3.0
MAX_ARRAY_ELEMENTS = 256
MAX_STRUCT_BUFFER_ELEMENTS = 64
MAX_GRAPH_NODES = 32
INT_MAX_THRESHOLD = 2147483600   # Detect INT_MAX (2147483647) / INF values

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
FIXED_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s]*?)\s*\[(\d+)\]$")
PTR_TYPE_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\*$")
FREE_CALL_RE = re.compile(r"\bfree(?:_graph|_list|_tree|_heap)?\s*\(\s*([a-zA-Z_][a-zA-Z0-9_\->\.\[\]]*)\s*\)")

# ==============================================================================
# Variable & Struct Field Classification Constants
# ==============================================================================

SIZE_VAR_CANDIDATES = {
    "n", "len", "length", "size", "count", "capacity", "cap",
    "max_size", "maxsize", "num", "v_size", "arr_size", "v", "V"
}

STRUCT_CAPACITY_FIELDS = (
    "capacity", "cap", "max_size", "maxsize", "alloc", "allocated",
    "size", "len", "length", "count", "n", "V", "num_vertices"
)

STRUCT_INDEX_FIELDS = {
    "top", "front", "rear", "head", "tail", "idx", "index", "pos",
    "curr", "current", "min_idx", "max_idx"
}

NON_INDEX_SCALAR_NAMES = {
    "n", "len", "length", "size", "count", "capacity", "cap", "max_size", "maxsize",
    "num", "v_size", "arr_size", "V", "d_u", "weight", "dist",
    "target", "key", "val", "value", "search", "x", "elem", "item", "needle",
    "tmp", "temp", "swap", "found", "res", "result", "ans", "ret", "flag", "sum", "max", "min"
}

INDEX_VAR_CANDIDATES = {
    "i", "j", "k", "u", "v", "src", "dest", "idx", "index", "min_idx", "max_idx",
    "pivot", "low", "high", "left", "right", "mid", "middle",
    "l", "r", "start", "end", "pos", "top", "front", "rear", "curr_idx", "smallest"
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

# Micro-helpers that should be stepped OVER atomically (`-exec-next`) rather than stepped into
ATOMIC_HELPER_PREFIXES = (
    "create_", "new_", "init_", "alloc_", "make_",
    "swap_", "is_", "has_", "get_", "set_", "free_", "destroy_", "delete_", "print_"
)
ATOMIC_HELPER_NAMES = {
    "add_edge", "insert_edge", "min_heapify", "max_heapify", "heapify",
    "extract_min", "extract_max", "decrease_key", "increase_key",
    "push_heap", "pop_heap"
}

STRUCT_VALUE_FIELDS = {"val", "value", "key", "data", "id", "info", "weight", "item", "top", "size", "capacity", "V", "dest", "dist"}


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
    mode: str = "pointer_mesh"  # "abstract_graph" or "pointer_mesh"


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
    """Extracts a canonical hex address (e.g. '0x4212a0') from GDB output."""
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
    """
    Returns True if GDB formatted a pointer value as 0x0 (NULL).
    Never treats a bare decimal '0' as NULL unless `is_known_pointer=True`.
    """
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
    """Parses a GDB scalar value string into a Python int, float, or canonical hex string."""
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


def format_distance_val(val: Any) -> Any:
    """Formats INT_MAX / INF values cleanly as '∞' for display."""
    if isinstance(val, int) and val >= INT_MAX_THRESHOLD:
        return "∞"
    return val


def parse_gdb_array(raw_val: str, max_elems: int = MAX_ARRAY_ELEMENTS) -> List[Any]:
    """Parses GDB's `{2, 5, 8, 1}` array string into a Python list."""
    raw_val = raw_val.strip()
    if not (raw_val.startswith("{") and raw_val.endswith("}")):
        return []
    inner = raw_val[1:-1].strip()
    if not inner:
        return []

    elements: List[Any] = []
    parts = [p.strip() for p in inner.split(",") if p.strip()]
    for part in parts:
        rep_match = re.match(r"^(.+?)\s*<repeats\s+(\d+)\s+times>$", part)
        if rep_match:
            base_val = parse_scalar(rep_match.group(1))
            count = min(int(rep_match.group(2)), max_elems)
            elements.extend([base_val] * count)
        else:
            elements.append(parse_scalar(part))
    return elements[:max_elems]


def parse_gdb_struct_body(raw_val: str) -> Dict[str, str]:
    """Parses `{val = 10, next = 0x4212c0}` into `{"val": "10", "next": "0x4212c0"}`."""
    raw_val = raw_val.strip()
    brace_start = raw_val.find("{")
    brace_end = raw_val.rfind("}")
    if brace_start == -1 or brace_end == -1 or brace_end <= brace_start:
        return {}

    inner = raw_val[brace_start + 1 : brace_end].strip()
    if not inner:
        return {}

    fields: Dict[str, str] = {}
    depth = 0
    current_token: List[str] = []
    tokens: List[str] = []

    for ch in inner:
        if ch == "{":
            depth += 1
            current_token.append(ch)
        elif ch == "}":
            depth -= 1
            current_token.append(ch)
        elif ch == "," and depth == 0:
            tokens.append("".join(current_token).strip())
            current_token = []
        else:
            current_token.append(ch)

    if current_token:
        tokens.append("".join(current_token).strip())

    for tok in tokens:
        if "=" in tok:
            k, v = tok.split("=", 1)
            fields[k.strip()] = v.strip()
    return fields


# ==============================================================================
# Optimized GDB-MI Session Controller (`GDBTracer`)
# ==============================================================================

class GDBTracer:
    """
    High-speed GDB/MI execution tracer with:
      - Mathematical Graph Adjacency List abstraction (`Graph *g` -> vertices `0..V-1` & weighted edges)
      - Persistent Graph root tracking across helper stack frames
      - Smart atomic step-over for micro-helpers (`add_edge`, `extract_min`, `decrease_key`, `min_heapify`)
      - Pointer-typedef ADT resolution & struct-embedded buffer inspection
    """

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

        # Persistent mathematical Graph root (var_name, hex_addr, struct_type)
        # so the graph never flickers or disappears if execution steps into a helper function.
        self._persistent_graph_root: Optional[Tuple[str, str, str]] = None

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
                    if (
                        self._persistent_graph_root
                        and self._persistent_graph_root[1] == addr
                    ):
                        self._persistent_graph_root = None

    def _is_declared_on_current_line(self, var_name: str) -> bool:
        if not (1 <= self._current_line < len(self._source_lines)):
            return False
        src_line = self._source_lines[self._current_line].split("//")[0].strip()
        if src_line.startswith("for ") or src_line.startswith("for("):
            return False
        decl_pattern = (
            rf"^(?:struct\s+[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z_][a-zA-Z0-9_]*)\s*\*?\s*"
            rf"\b{re.escape(var_name)}\s*="
        )
        return bool(re.search(decl_pattern, src_line))

    def _should_step_into_current_line(self) -> bool:
        """
        Steps INTO primary algorithm functions (`dijkstra`, `bfs`, `dfs`, `bellman_ford`, `prim`,
        `binary_search`, `quick_sort`, `merge_sort`, `push`, `pop`), while stepping OVER (`-exec-next`)
        trivial constructors, swaps, predicates, and heapify micro-helpers (`new_adj_node`,
        `add_edge`, `extract_min`, `decrease_key`, `min_heapify`, `free_graph`).
        """
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

        # Only step into the line if at least one called function is NOT a micro-helper
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
        clean = raw_type.replace("const", "").replace("volatile", "").strip()
        if clean in self._type_resolution_cache:
            return self._type_resolution_cache[clean]

        if clean in PRIMITIVE_TYPES:
            res = ("primitive", clean)
            self._type_resolution_cache[clean] = res
            return res

        ptr_match = PTR_TYPE_RE.match(clean)
        if ptr_match:
            base = ptr_match.group(1).strip()
            if base in PRIMITIVE_TYPES:
                res = ("primitive_ptr", base)
                self._type_resolution_cache[clean] = res
                return res
            if base.startswith("struct "):
                self._ensure_struct_field_types(base)
                res = ("struct_ptr", base)
                self._type_resolution_cache[clean] = res
                return res
            base_kind, base_resolved = self._resolve_type_info(base)
            if base_kind == "struct_val":
                res = ("struct_ptr", base_resolved)
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
                header_match.group(1).strip() if header_match else clean
            )
            self._parse_and_cache_ptype_fields(canonical_struct, full_console)
            if canonical_struct != clean:
                self._struct_field_types_cache[clean] = (
                    self._struct_field_types_cache[canonical_struct]
                )

            brace_end = full_console.rfind("}")
            tail = full_console[brace_end + 1 :].strip() if brace_end != -1 else ""
            if "*" in tail:
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
            if f_kind in {"primitive_ptr", "struct_ptr"} or "*" in clean_type:
                return (True, f_kind, f_target_type)
            if f_kind in {"primitive", "struct_val"}:
                return (False, f_kind, f_target_type)

        val_stripped = f_val.strip().lower()
        if val_stripped.startswith("0x") or HEX_ADDR_RE.search(val_stripped):
            return (True, "other", "")

        return (False, "primitive", clean_type or "int")

    def inspect_state(self) -> Optional[ExecutionSnapshot]:
        self._check_budget()
        if (
            self._current_file != self.source_path.name
            or self._current_line <= 0
        ):
            return None

        var_responses = self._cmd("-stack-list-variables --simple-values")
        raw_vars: List[Dict[str, str]] = []
        for r in var_responses:
            if r.get("type") == "result" and r.get("message") == "done":
                raw_vars = r.get("payload", {}).get("variables", [])
                break

        locals_out: Dict[str, Any] = {}
        scalar_ints: Dict[str, int] = {}
        active_struct_ptrs: Dict[str, Tuple[str, str]] = {}
        raw_array_vars: List[Tuple[str, str, int]] = []
        raw_ptr_vars: List[Tuple[str, str, str]] = []

        # ----------------------------------------------------------------------
        # Pass 1: Classify all variables in scope
        # ----------------------------------------------------------------------
        for v in raw_vars:
            v_name = v.get("name", "")
            v_type = v.get("type", "").strip()
            v_val = v.get("value", "")

            if not v_name or not v_type:
                continue

            if self._is_declared_on_current_line(v_name):
                continue

            arr_match = FIXED_ARR_RE.match(v_type)
            if arr_match:
                elem_type = arr_match.group(1).strip()
                arr_len = min(int(arr_match.group(2)), MAX_ARRAY_ELEMENTS)
                raw_array_vars.append((v_name, elem_type, arr_len))
                continue

            type_kind, resolved_target = self._resolve_type_info(v_type)

            if type_kind == "struct_ptr":
                addr = extract_hex_address(v_val)
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

            if type_kind == "primitive_ptr":
                addr = extract_hex_address(v_val)
                locals_out[v_name] = addr if addr else "0x0"
                if addr:
                    raw_ptr_vars.append((v_name, resolved_target, addr))
                continue

            if type_kind == "struct_val":
                addr_raw = self._eval_expr(f"&{v_name}")
                addr = extract_hex_address(addr_raw or "")
                if addr:
                    active_struct_ptrs[v_name] = (addr, resolved_target)
                    locals_out[v_name] = addr
                continue

            parsed_val = parse_scalar(v_val)
            if isinstance(parsed_val, int):
                scalar_ints[v_name] = parsed_val
                locals_out[v_name] = format_distance_val(parsed_val)
            else:
                locals_out[v_name] = parsed_val

        # ----------------------------------------------------------------------
        # Pass 2: Top-Level Contiguous Arrays (Fixed Stack + Dynamic Heap Buffers like `dist`)
        # ----------------------------------------------------------------------
        arrays_snapshot: List[ArraySnapshot] = []
        inferred_len = self._infer_dynamic_array_length(scalar_ints)

        for arr_name, elem_type, _ in raw_array_vars:
            expr_val = self._eval_expr(arr_name)
            if expr_val:
                elements = [
                    format_distance_val(x) for x in parse_gdb_array(expr_val)
                ]
                active_idx = self._collect_active_indices(scalar_ints, len(elements))
                arrays_snapshot.append(
                    ArraySnapshot(
                        name=arr_name,
                        type=elem_type,
                        elements=elements,
                        active_indices=active_idx,
                    )
                )

        # Keep raw integer array values (e.g. `dist`) for the mathematical graph overlay
        live_arrays_raw: Dict[str, List[Any]] = {}

        for ptr_name, elem_type, addr in raw_ptr_vars:
            if (
                addr not in self._freed_addresses
                and inferred_len
                and 1 <= inferred_len <= MAX_ARRAY_ELEMENTS
                and self._is_valid_heap_or_data_address(addr)
            ):
                deref_expr = f"*({elem_type}[{inferred_len}]*){ptr_name}"
                expr_val = self._eval_expr(deref_expr)
                if expr_val:
                    raw_elements = parse_gdb_array(expr_val)
                    if raw_elements:
                        live_arrays_raw[ptr_name] = raw_elements
                        formatted_elements = [
                            format_distance_val(x) for x in raw_elements
                        ]
                        active_idx = self._collect_active_indices(
                            scalar_ints, len(formatted_elements)
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
        # Pass 3: Mathematical Graph Adjacency List Detection OR Raw Pointer Mesh
        # ----------------------------------------------------------------------
        abstract_graph = self._try_extract_mathematical_graph(
            active_struct_ptrs, scalar_ints, live_arrays_raw
        )

        if abstract_graph is not None:
            graph_snapshot = abstract_graph
            # Still extract embedded primitive arrays (e.g., `h->pos` from MinHeap)
            _, embedded_arrays = self._crawl_pointer_graph(
                active_struct_ptrs, scalar_ints, skip_graph_struct=True
            )
            arrays_snapshot.extend(embedded_arrays)
        else:
            graph_snapshot, embedded_arrays = self._crawl_pointer_graph(
                active_struct_ptrs, scalar_ints, skip_graph_struct=False
            )
            arrays_snapshot.extend(embedded_arrays)

        self.step_count += 1
        call_stack = (
            ["main"]
            if self._current_func == "main"
            else ["main", self._current_func]
        )

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

    def _try_extract_mathematical_graph(
        self,
        active_struct_ptrs: Dict[str, Tuple[str, str]],
        scalar_ints: Dict[str, int],
        live_arrays_raw: Dict[str, List[Any]],
    ) -> Optional[GraphSnapshot]:
        """
        Detects if an active (or cached persistent) struct represents a mathematical Graph
        with an adjacency list (`V` vertices + `adj` array of `AdjListNode*` pointers).
        When detected, constructs an intuitive mathematical graph:
          - Nodes: `"node-0"` .. `"node-(V-1)"` with `dist` and PQ status
          - Edges: `"node-u"` -> `"node-v"` with `"w: <weight>"`
          - Active pointers: `u ↓`, `v ↓`, `src ↓`
        """
        graph_candidate: Optional[Tuple[str, str, str]] = None

        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if not self._is_valid_heap_or_data_address(addr) or addr in self._freed_addresses:
                continue
            f_types = self._ensure_struct_field_types(s_type)
            has_v = any(k in f_types for k in ("V", "num_vertices", "n", "nv", "vertices"))
            has_adj = any(k in f_types for k in ("adj", "head", "lists", "edges", "array"))
            if has_v and has_adj and ("Graph" in s_type or "adj" in f_types):
                graph_candidate = (ptr_name, addr, s_type)
                self._persistent_graph_root = graph_candidate
                break

        if graph_candidate is None and self._persistent_graph_root is not None:
            cached_name, cached_addr, cached_type = self._persistent_graph_root
            if cached_addr not in self._freed_addresses:
                graph_candidate = (cached_name, cached_addr, cached_type)

        if graph_candidate is None:
            return None

        _, g_addr, g_type = graph_candidate
        g_deref = self._eval_expr(f"*(({g_type} *){g_addr})")
        if not g_deref:
            return None

        g_fields = parse_gdb_struct_body(g_deref)
        v_str = (
            g_fields.get("V")
            or g_fields.get("num_vertices")
            or g_fields.get("n")
            or "0"
        )
        num_v = parse_scalar(v_str)
        if not isinstance(num_v, int) or not (1 <= num_v <= MAX_GRAPH_NODES):
            return None

        adj_addr = extract_hex_address(g_fields.get("adj") or g_fields.get("head") or "")
        if not adj_addr or not self._is_valid_heap_or_data_address(adj_addr):
            return None

        # Read the array of `AdjListNode *` pointers: `*(void *[V]*)(g->adj)`
        adj_ptrs_raw = self._eval_expr(f"*(void *[{num_v}]*)({adj_addr})")
        if not adj_ptrs_raw:
            return None
        adj_head_addrs = parse_gdb_array(adj_ptrs_raw, max_elems=num_v)

        # Determine adjacency node struct type (e.g. `struct AdjListNode`)
        g_field_types = self._ensure_struct_field_types(g_type)
        adj_decl_type = g_field_types.get("adj", "struct AdjListNode **")
        adj_node_type = adj_decl_type.replace("*", "").strip()
        if not adj_node_type.startswith("struct "):
            _, resolved_adj = self._resolve_type_info(adj_node_type)
            adj_node_type = resolved_adj or "struct AdjListNode"

        # Check if `MinHeap *h` is in scope to determine which vertices are still in the Priority Queue
        in_pq_vertices: Set[int] = set()
        for _, (h_addr, h_type) in active_struct_ptrs.items():
            if "Heap" in h_type and self._is_valid_heap_or_data_address(h_addr):
                h_deref = self._eval_expr(f"*(({h_type} *){h_addr})")
                if h_deref:
                    h_fields = parse_gdb_struct_body(h_deref)
                    h_size = parse_scalar(h_fields.get("size", "0"))
                    pos_addr = extract_hex_address(h_fields.get("pos", ""))
                    if (
                        isinstance(h_size, int)
                        and 0 <= h_size <= num_v
                        and pos_addr
                        and self._is_valid_heap_or_data_address(pos_addr)
                    ):
                        pos_raw = self._eval_expr(f"*(int[{num_v}]*)({pos_addr})")
                        if pos_raw:
                            pos_list = parse_gdb_array(pos_raw, max_elems=num_v)
                            for vert_idx, p_val in enumerate(pos_list):
                                if isinstance(p_val, int) and p_val < h_size:
                                    in_pq_vertices.add(vert_idx)

        dist_list = live_arrays_raw.get("dist", [])

        # Identify active vertex indices (`u`, `v`, `src`) from local variables
        u_val = scalar_ints.get("u")
        v_val = scalar_ints.get("v")
        src_val = scalar_ints.get("src")

        # Also check if `crawl` points to a specific `AdjListNode` right now
        crawl_dest: Optional[int] = None
        if "crawl" in active_struct_ptrs:
            c_addr, c_type = active_struct_ptrs["crawl"]
            if self._is_valid_heap_or_data_address(c_addr):
                c_deref = self._eval_expr(f"*(({c_type} *){c_addr})")
                if c_deref:
                    c_fields = parse_gdb_struct_body(c_deref)
                    d_parsed = parse_scalar(c_fields.get("dest", "-1"))
                    if isinstance(d_parsed, int) and 0 <= d_parsed < num_v:
                        crawl_dest = d_parsed

        # Build vertex nodes: `node-0`, `node-1`, ..., `node-(V-1)`
        nodes: List[GraphNode] = []
        stack_pointers_out: Dict[str, str] = {}

        for idx in range(num_v):
            node_id = f"node-{idx}"
            ptrs: List[str] = []

            if isinstance(src_val, int) and src_val == idx:
                ptrs.append("src")
                stack_pointers_out["src"] = node_id
            if isinstance(u_val, int) and u_val == idx:
                ptrs.append("u")
                stack_pointers_out["u"] = node_id
            if (
                isinstance(v_val, int)
                and v_val == idx
                and self._current_func == "dijkstra"
                and "u" in scalar_ints
            ):
                ptrs.append("v")
                stack_pointers_out["v"] = node_id
            elif crawl_dest == idx and "v" not in ptrs:
                ptrs.append("crawl->dest")

            raw_d = dist_list[idx] if idx < len(dist_list) else None
            formatted_d = format_distance_val(raw_d) if raw_d is not None else "—"

            status_str = (
                "IN_PQ"
                if idx in in_pq_vertices
                else ("SETTLED" if dist_list else "VERTEX")
            )

            fields_dict: Dict[str, Any] = {"vertex": idx}
            if raw_d is not None:
                fields_dict["dist"] = formatted_d
                fields_dict["status"] = status_str

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
                    is_active=(idx == u_val or idx == v_val or idx == crawl_dest),
                    is_freed=False,
                    pointers=ptrs,
                )
            )

        # Traverse adjacency lists for each vertex `0 .. V-1`
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
                dest_v = parse_scalar(nf.get("dest", nf.get("v", "-1")))
                weight_w = parse_scalar(nf.get("weight", nf.get("w", "1")))

                if isinstance(dest_v, int) and 0 <= dest_v < num_v:
                    raw_directed_edges.append((u_idx, dest_v, weight_w))

                curr_addr = extract_hex_address(nf.get("next", ""))

        # Check if all edges are symmetric (undirected graph where add_edge adds u->v and v->u)
        edge_lookup = {(u, v, str(w)) for u, v, w in raw_directed_edges}
        edges: List[GraphEdge] = []
        emitted_undirected: Set[Tuple[int, int, str]] = set()

        for u_idx, v_idx, w_val in raw_directed_edges:
            w_str = str(w_val)
            is_symmetric = (v_idx, u_idx, w_str) in edge_lookup
            if is_symmetric:
                canon_pair = (min(u_idx, v_idx), max(u_idx, v_idx), w_str)
                if canon_pair in emitted_undirected:
                    continue
                emitted_undirected.add(canon_pair)

            is_active_edge = (
                isinstance(u_val, int)
                and (
                    (u_val == u_idx and (v_val == v_idx or crawl_dest == v_idx))
                    or (is_symmetric and u_val == v_idx and (v_val == u_idx or crawl_dest == u_idx))
                )
            )

            src_id = f"node-{u_idx}"
            tgt_id = f"node-{v_idx}"
            edges.append(
                GraphEdge(
                    source=src_id,
                    target=tgt_id,
                    from_node=src_id,
                    to_node=tgt_id,
                    label=f"w: {w_val}",
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
        skip_graph_struct: bool = False,
    ) -> Tuple[GraphSnapshot, List[ArraySnapshot]]:
        visited_addrs: Set[str] = set()
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        embedded_arrays: List[ArraySnapshot] = []
        seen_edges: Set[Tuple[str, str, str]] = set()
        seen_embedded_buffers: Set[str] = set()

        addr_to_ptr_names: Dict[str, List[str]] = {}
        stack_pointers_out: Dict[str, str] = {}
        valid_seeds: List[Tuple[str, str, str]] = []

        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if skip_graph_struct and ("Graph" in s_type or "AdjList" in s_type):
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
                        embedded_arrays.append(
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
                                    arr_display_name = f"{owner_name}->{f_name}"
                                    embedded_arrays.append(
                                        ArraySnapshot(
                                            name=arr_display_name,
                                            type=elem_c_type,
                                            elements=elements,
                                            active_indices=active_idx,
                                        )
                                    )

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
                                                pointers=[arr_display_name],
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

                    if "**" in declared_f_type:
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
                if node_label is None and f_name.lower() in STRUCT_VALUE_FIELDS:
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

        return (
            GraphSnapshot(
                nodes=nodes,
                edges=edges,
                stack_pointers=stack_pointers_out,
                mode="pointer_mesh",
            ),
            embedded_arrays,
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
            if name.lower() in SIZE_VAR_CANDIDATES or name.lower().endswith(
                ("_len", "_size", "_count")
            ):
                if 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val
        return None

    def _collect_active_indices(
        self, scalar_ints: Dict[str, int], array_len: int
    ) -> Dict[str, int]:
        active: Dict[str, int] = {}
        for var_name, val in scalar_ints.items():
            # Keep uppercase 'V' (vertex count) excluded from array indices, while allowing lowercase 'v' (neighbor vertex index)
            if var_name == "V":
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
