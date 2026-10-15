#!/usr/bin/env python3
"""
backend/src/debugger/gdb_engine.py

High-performance GDB/MI Execution Tracer & Recursive Heap Mesh Crawler.
Features:
  - Emits `stack_pointers` map and per-node `pointers: List[str]` (`head`, `curr`, `second`).
  - Tracks `free()` calls and `ptmalloc2` tcache safe-linking mangling (`addr >> 12`) to mark
    freed heap chunks with `is_freed: True` (`[FREED / DANGLING]`) without following corrupt pointers.
  - Smart stepping (`-exec-step` into user functions, `-exec-next` over stdlib routines).
  - Uninitialized current-line declaration guard (`int middle = ...` before execution).
  - Full dynamic index association (`middle`, `mid`, `low`, `high`, `pivot`, `i`, `j`, etc.)
    while preserving search target scalars (`target`, `key`) in `stack_frames.locals`.
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
MAX_STEPS = 500
SESSION_TIMEOUT_SEC = 20.0
STEP_INACTIVITY_TIMEOUT_SEC = 3.0
MAX_ARRAY_ELEMENTS = 256
MAX_GRAPH_NODES = 20

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
FIXED_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s]*?)\s*\[(\d+)\]$")
PTR_TYPE_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\*$")
FREE_CALL_RE = re.compile(r"\bfree\s*\(\s*([a-zA-Z_][a-zA-Z0-9_\->\.\[\]]*)\s*\)")

# ==============================================================================
# Variable Classification Constants
# ==============================================================================

SIZE_VAR_CANDIDATES = {
    "n", "len", "length", "size", "count", "capacity", "num", "v_size", "arr_size"
}

# Variables that represent array sizes, search targets, temporary swap values, or return flags
# (Excluded from array index badges even if their numeric value happens to fall in [0, n-1])
NON_INDEX_SCALAR_NAMES = {
    "n", "len", "length", "size", "count", "capacity", "num", "v_size", "arr_size",
    "target", "key", "val", "value", "search", "x", "elem", "item", "needle",
    "tmp", "temp", "swap", "found", "res", "result", "ans", "ret", "flag", "sum", "max", "min"
}

# Explicit index variable names (allowed to show at boundary -1 or array_len for loop termination)
INDEX_VAR_CANDIDATES = {
    "i", "j", "k", "idx", "index", "min_idx", "max_idx",
    "pivot", "low", "high", "left", "right", "mid", "middle",
    "l", "r", "start", "end", "pos", "top", "front", "rear", "curr_idx"
}

STDLIB_CALL_RE = re.compile(
    r"\b(malloc|calloc|realloc|free|printf|fprintf|sprintf|snprintf|scanf|fscanf|puts|putchar|getchar|memcpy|memmove|memset|memcmp|strlen|strcpy|strncpy|strcmp|exit|abort)\s*\("
)
USER_FUNC_CALL_RE = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(")
C_CONTROL_KEYWORDS = {"if", "for", "while", "switch", "return", "sizeof", "typeof"}

STRUCT_VALUE_FIELDS = {"val", "value", "key", "data", "id", "info", "weight", "item"}


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
    from_node: Optional[str] = Field(default=None, alias="from")
    to_node: Optional[str] = Field(default=None, alias="to")

    class Config:
        populate_by_name = True


class GraphSnapshot(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    stack_pointers: Dict[str, str] = Field(default_factory=dict)


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


def is_explicit_null(raw_val: str) -> bool:
    """Returns True if GDB formatted a pointer field as 0x0 (NULL)."""
    val = raw_val.strip().lower()
    if val in {"0x0", "0", "null"}:
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


def parse_gdb_array(raw_val: str) -> List[Any]:
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
            count = min(int(rep_match.group(2)), MAX_ARRAY_ELEMENTS)
            elements.extend([base_val] * count)
        else:
            elements.append(parse_scalar(part))
    return elements[:MAX_ARRAY_ELEMENTS]


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
      - `stack_pointers` and per-node `pointers` mapping (`head`, `curr`, `second`)
      - Automatic `free()` detection & glibc tcache safe-linking poison detection
      - Smart user-function stepping & uninitialized variable guard
      - Full dynamic array index association (`middle`, `low`, `high`, `pivot`, `i`, `j`)
      - Recursive BFS heap graph discovery
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

        # Source lines (1-indexed) to inspect `free(ptr)`, declarations, and function calls
        self._source_lines: List[str] = [""]
        if self.source_path.exists():
            self._source_lines.extend(
                self.source_path.read_text(encoding="utf-8", errors="replace").splitlines()
            )

        # Caches for struct reflection and freed heap tracking
        self._struct_type_cache: Dict[str, bool] = {}
        self._struct_field_types_cache: Dict[str, Dict[str, str]] = {}
        self._freed_addresses: Set[str] = set()
        # Preserves last known clean scalar fields of a heap node before `free()` overwrote it
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
        """
        Checks if the current source line about to be stepped over contains `free(<expr>)`.
        If so, evaluates `<expr>` right before execution and records the target address
        in `self._freed_addresses`.
        """
        if 1 <= self._current_line < len(self._source_lines):
            src_line = self._source_lines[self._current_line]
            src_line = src_line.split("//")[0]
            for match in FREE_CALL_RE.finditer(src_line):
                ptr_expr = match.group(1).strip()
                raw_addr = self._eval_expr(ptr_expr)
                addr = extract_hex_address(raw_addr or "")
                if addr and self._is_valid_heap_or_data_address(addr):
                    self._freed_addresses.add(addr)

    def _is_declared_on_current_line(self, var_name: str) -> bool:
        """
        Returns True if `var_name` is being declared and initialized on `self._current_line`
        (e.g. `int middle = low + (high - low) / 2;`).
        Because GDB stops BEFORE executing `self._current_line`, `var_name` holds uninitialized
        stack bytes until the line executes on the next step.
        """
        if not (1 <= self._current_line < len(self._source_lines)):
            return False
        src_line = self._source_lines[self._current_line].split("//")[0].strip()
        # Do not suppress loop headers like `for (int i = 0; i < n; i++)` once inside the loop
        if src_line.startswith("for ") or src_line.startswith("for("):
            return False
        decl_pattern = (
            rf"\b(?:int|long|short|size_t|ssize_t|unsigned|float|double|char)\s+"
            rf"[^;]*\b{re.escape(var_name)}\s*="
        )
        return bool(re.search(decl_pattern, src_line))

    def _should_step_into_current_line(self) -> bool:
        """
        Determines whether the current C line calls a user-defined algorithm function
        (e.g. `binary_search(v, n, target)`) vs a standard library routine (`malloc`, `free`, `printf`)
        or node-allocation factory (`create_node`).
        """
        if not (1 <= self._current_line < len(self._source_lines)):
            return False
        src_line = self._source_lines[self._current_line].split("//")[0].strip()
        if not src_line:
            return False

        # Step over standard library routines so we never enter glibc internals
        if STDLIB_CALL_RE.search(src_line):
            return False

        for match in USER_FUNC_CALL_RE.finditer(src_line):
            fn_name = match.group(1)
            # Keep node allocation helpers atomic so `main`'s pointer mesh stays in scope
            if fn_name in C_CONTROL_KEYWORDS or fn_name.startswith("create_"):
                continue
            return True
        return False

    def step_next_user_line(self) -> bool:
        """
        Advances execution by one source line in `target.c`.
        Uses `-exec-step` when a user algorithm function is called on the line,
        and `-exec-next` on normal lines and stdlib calls.
        """
        self._check_budget()
        self._record_pending_free_on_current_line()

        mi_step_cmd = (
            "-exec-step" if self._should_step_into_current_line() else "-exec-next"
        )
        responses = self._cmd(mi_step_cmd)
        if self._update_stop_state(responses):
            return False

        # If -exec-step entered an external glibc header/function, finish back to target.c
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

            # Skip variables whose declaration on the current line has not executed yet
            if self._is_declared_on_current_line(v_name):
                continue

            arr_match = FIXED_ARR_RE.match(v_type)
            if arr_match:
                elem_type = arr_match.group(1).strip()
                arr_len = min(int(arr_match.group(2)), MAX_ARRAY_ELEMENTS)
                raw_array_vars.append((v_name, elem_type, arr_len))
                continue

            ptr_match = PTR_TYPE_RE.match(v_type)
            if ptr_match:
                target_type = ptr_match.group(1).strip()
                addr = extract_hex_address(v_val)
                locals_out[v_name] = addr if addr else "0x0"

                if not addr:
                    continue

                if self._is_struct_type(target_type):
                    # If the pointer was re-allocated via malloc, unmark from freed set
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
                        ):
                            self._freed_addresses.discard(addr)
                    active_struct_ptrs[v_name] = (addr, target_type)
                elif target_type in {
                    "int", "long", "short", "float", "double",
                    "unsigned int", "size_t", "char"
                }:
                    raw_ptr_vars.append((v_name, target_type, addr))
                continue

            if self._is_struct_type(v_type) and not v_type.endswith("*"):
                addr_raw = self._eval_expr(f"&{v_name}")
                addr = extract_hex_address(addr_raw or "")
                if addr:
                    active_struct_ptrs[v_name] = (addr, v_type)
                    locals_out[v_name] = addr
                continue

            parsed_val = parse_scalar(v_val)
            locals_out[v_name] = parsed_val
            if isinstance(parsed_val, int):
                scalar_ints[v_name] = parsed_val

        # ----------------------------------------------------------------------
        # Pass 2: Contiguous Arrays (Fixed Stack + Dynamic Heap Buffers)
        # ----------------------------------------------------------------------
        arrays_snapshot: List[ArraySnapshot] = []
        inferred_len = self._infer_dynamic_array_length(scalar_ints)

        for arr_name, elem_type, _ in raw_array_vars:
            expr_val = self._eval_expr(arr_name)
            if expr_val:
                elements = parse_gdb_array(expr_val)
                active_idx = self._collect_active_indices(scalar_ints, len(elements))
                arrays_snapshot.append(
                    ArraySnapshot(
                        name=arr_name,
                        type=elem_type,
                        elements=elements,
                        active_indices=active_idx,
                    )
                )

        for ptr_name, elem_type, addr in raw_ptr_vars:
            if (
                addr not in self._freed_addresses
                and inferred_len
                and 1 <= inferred_len <= MAX_ARRAY_ELEMENTS
            ):
                deref_expr = f"*({elem_type}[{inferred_len}]*){ptr_name}"
                expr_val = self._eval_expr(deref_expr)
                if expr_val:
                    elements = parse_gdb_array(expr_val)
                    if elements:
                        active_idx = self._collect_active_indices(
                            scalar_ints, len(elements)
                        )
                        arrays_snapshot.append(
                            ArraySnapshot(
                                name=ptr_name,
                                type=elem_type,
                                elements=elements,
                                active_indices=active_idx,
                            )
                        )

        # ----------------------------------------------------------------------
        # Pass 3: Recursive BFS Heap Pointer & Graph Mesh Discovery
        # ----------------------------------------------------------------------
        graph_snapshot = self._crawl_pointer_graph(active_struct_ptrs)

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

    def _is_struct_type(self, type_name: str) -> bool:
        clean = type_name.replace("const", "").strip()
        if clean in self._struct_type_cache:
            return self._struct_type_cache[clean]

        if clean.startswith("struct "):
            self._struct_type_cache[clean] = True
            self._ensure_struct_field_types(clean)
            return True

        primitives = {
            "int", "long", "short", "char", "void", "float", "double",
            "unsigned int", "unsigned long", "unsigned char", "unsigned short",
            "int8_t", "int16_t", "int32_t", "int64_t",
            "uint8_t", "uint16_t", "uint32_t", "uint64_t",
            "size_t", "ssize_t", "bool", "_Bool", "FILE",
        }
        if clean in primitives or clean.endswith("*"):
            self._struct_type_cache[clean] = False
            return False

        responses = self._cmd(f"ptype {clean}")
        is_struct = False
        for r in responses:
            if r.get("type") == "console":
                payload = r.get("payload", "")
                if "type = struct" in payload:
                    is_struct = True
                    self._parse_and_cache_ptype_fields(clean, payload)
                    break

        self._struct_type_cache[clean] = is_struct
        return is_struct

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
        if val >= 0x7f0000000000:
            return False
        return True

    def _is_tcache_poisoned(self, addr: str, raw_fields: Dict[str, str]) -> bool:
        """
        Heuristic backup for detecting glibc ptmalloc2 tcache corruption when memory
        was freed inside a helper function:
        When chunk `addr` is freed into an empty tcache bin, glibc writes `addr >> 12`
        at offset 0 (the first field). For `0x4212a0`, `0x4212a0 >> 12 == 0x421 == 1057`.
        """
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

    def _crawl_pointer_graph(
        self, active_struct_ptrs: Dict[str, Tuple[str, str]]
    ) -> GraphSnapshot:
        """
        BFS heap discovery starting from all struct pointer locals (`head`, `second`, `curr`).
        Populates:
          - `stack_pointers`: `{"head": "0x4212a0", "second": "0x4212c0", "curr": "0x4212c0"}`
          - `node.pointers`: `["head", "curr"]` on each `GraphNode`
          - `node.is_freed`: `True` if `free()` was called on that address
        """
        visited_addrs: Set[str] = set()
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        seen_edges: Set[Tuple[str, str, str]] = set()

        addr_to_ptr_names: Dict[str, List[str]] = {}
        stack_pointers_out: Dict[str, str] = {}
        valid_seeds: List[Tuple[str, str]] = []

        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if self._is_valid_heap_or_data_address(addr):
                stack_pointers_out[ptr_name] = addr
                addr_to_ptr_names.setdefault(addr, []).append(ptr_name)
                valid_seeds.append((addr, s_type))

        queue: List[Tuple[str, str]] = list(valid_seeds)

        while queue and len(visited_addrs) < MAX_GRAPH_NODES:
            addr, struct_type = queue.pop(0)
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

            # If this chunk was freed, do NOT follow its overwritten tcache key/next fields!
            if is_freed:
                last_known = self._last_valid_node_fields.get(addr, {})
                freed_fields: Dict[str, Any] = {}
                for k, v in last_known.items():
                    freed_fields[k] = v
                if not freed_fields:
                    freed_fields["status"] = "FREED (tcache)"

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

            node_fields: Dict[str, Any] = {}
            node_label: Optional[str] = None

            for f_name, f_val in raw_fields.items():
                declared_f_type = field_types.get(f_name, "")

                # Case 1: Inline array of pointers
                if f_val.startswith("{") and f_val.endswith("}"):
                    sub_items = parse_gdb_array(f_val)
                    node_fields[f_name] = sub_items
                    target_s_type = (
                        declared_f_type.rstrip("*").strip()
                        if "*" in declared_f_type
                        else struct_type
                    )
                    for idx, item in enumerate(sub_items):
                        sub_addr = extract_hex_address(str(item))
                        if sub_addr and self._is_valid_heap_or_data_address(sub_addr):
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
                                queue.append((sub_addr, target_s_type))
                    continue

                # Case 2: Pointer field (`next`, `prev`, `left`, `right`, etc.)
                is_ptr_field = (
                    "*" in declared_f_type
                    or f_name in {"next", "prev", "left", "right", "parent", "child", "link"}
                )
                target_addr = extract_hex_address(f_val)

                if is_ptr_field or target_addr or is_explicit_null(f_val):
                    if is_explicit_null(f_val) or not target_addr:
                        node_fields[f_name] = "NULL"
                        continue

                    node_fields[f_name] = target_addr
                    if self._is_valid_heap_or_data_address(target_addr):
                        target_s_type = (
                            declared_f_type.rstrip("*").strip()
                            if "*" in declared_f_type
                            else struct_type
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
                            queue.append((target_addr, target_s_type))
                    continue

                # Case 3: Scalar value field (`val`, `key`, `data`, etc.)
                parsed_scalar = parse_scalar(f_val)
                node_fields[f_name] = parsed_scalar
                if node_label is None and f_name.lower() in STRUCT_VALUE_FIELDS:
                    node_label = str(parsed_scalar)

            if node_label is None:
                node_label = str(next(iter(node_fields.values()), addr[-4:]))

            # Cache clean fields while chunk is live so if it is freed later we know its prior state
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

        return GraphSnapshot(
            nodes=nodes,
            edges=edges,
            stack_pointers=stack_pointers_out,
        )

    def _infer_dynamic_array_length(self, scalar_ints: Dict[str, int]) -> Optional[int]:
        priority_names = ["n", "len", "length", "size", "count", "capacity", "num"]
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
        """
        Dynamically maps in-scope integer variables to array indices:
        1. Explicit index names (`i`, `j`, `middle`, `mid`, `low`, `high`, `left`, `right`, `pivot`)
           are included when within `[-1, array_len]` (allowing boundary OOB visibility).
        2. Any other integer variable (not in `NON_INDEX_SCALAR_NAMES` like `target` or `n`)
           whose value falls strictly within `[0, array_len - 1]` is included automatically.
        """
        active: Dict[str, int] = {}
        for var_name, val in scalar_ints.items():
            low_name = var_name.lower()

            # Never treat array lengths (`n`, `size`) or search keys (`target`, `key`) as indices
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
                # Arbitrary user index variable in [0, array_len - 1]
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
