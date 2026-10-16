#!/usr/bin/env python3
"""
backend/src/debugger/gdb_engine.py

High-Throughput, Purely Structural DWARF/GDB-MI Introspection Engine for C-Memory-Studio.
Zero hardcoded variable names, struct member names, or algorithm presets.

Key Capabilities:
  1. Strict User-Scope Variable & Type Filtering:
     - Blocks all glibc/pthread/runtime internal symbols (`@entry`, `__*`, `unwind_buf`,
       `cancel_jmp_buf`, `pthread_*`) and cross-checks variable identifiers against tokens
       present in the user's `target.c` source file.
  2. Unified 2D Matrix Schema (`kind: "matrix"`):
     - Multi-dimensional stack arrays (`T[R][C]`) and heap pointer matrices (`T**`) emit
       a single composite `ArraySnapshot` with `kind="matrix"`, `dimensions=[R, C]`, and `rows=[[...]]`.
  3. Recursion & Memory Lifecycle Continuity (`_live_heap_structs`):
     - Retains allocated heap structs across recursive base cases (`root == NULL`) and
       preserves freed heap nodes (`is_freed=True`) even after stack pointers go out of scope.
  4. GDB/MI Tokenized Command Pipelining (`_eval_expr_batch`) & Session `_type_cache`.
  5. Step Budget: `MAX_STEPS = 1500`.
"""

import asyncio
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel, Field
from pygdbmi.gdbcontroller import GdbController

# ==============================================================================
# Configuration & Safety Limits
# ==============================================================================

TMPFS_ROOT = Path(os.getenv("TMPFS_PATH", "/sandbox/workspace"))
MAX_STEPS = 1500
SESSION_TIMEOUT_SEC = 45.0
STEP_INACTIVITY_TIMEOUT_SEC = 3.0
MAX_ARRAY_ELEMENTS = 256
MAX_MATRIX_DIM = 16
MAX_STRUCT_BUFFER_ELEMENTS = 64
MAX_GRAPH_NODES = 48
INF_SENTINEL_VALUES = {2147483647, 1061109567, 1000000000, 999999999, 999999, 99999, 65535}
INT_MAX_THRESHOLD = 1000000000

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
FIXED_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\[(\d+)\]$")
FIXED_2D_ARR_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\[(\d+)\]\s*\[(\d+)\]$")
PTR_TYPE_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_\s\*]*?)\s*\*$")
FREE_CALL_RE = re.compile(
    r"\bfree\s*\(\s*([a-zA-Z_][a-zA-Z0-9_\->\.\[\]]*)\s*\)"
)

# ==============================================================================
# C Lexical, Grammar & Runtime Noise Filter Constants
# ==============================================================================

C_SYNTAX_KEYWORDS = {
    "auto", "break", "case", "char", "const", "continue", "default", "do",
    "double", "else", "enum", "extern", "float", "for", "goto", "if",
    "inline", "int", "long", "register", "restrict", "return", "short",
    "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
    "unsigned", "void", "volatile", "while", "_Bool", "bool", "size_t",
    "ssize_t", "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t", "NULL", "true", "false"
}

# System / glibc / pthread runtime symbols that must never be surfaced as user variables
SYSTEM_RUNTIME_SUBSTRINGS = (
    "unwind_buf",
    "cancel_jmp_buf",
    "pthread",
    "__libc",
    "_IO_",
    "_dl_",
    "not_first_call",
    "__PRETTY_FUNCTION__",
    "__func__",
    "__FUNCTION__",
)

SYSTEM_ENTRY_FUNCTIONS = {
    "__libc_start_call_main",
    "__libc_start_main",
    "_start",
    "exit",
    "__GI_exit",
    "_dl_fini",
}

C_CONTROL_KEYWORDS = {"if", "for", "while", "switch", "return", "sizeof", "typeof", "else", "case"}
C_LOOP_STATEMENT_RE = re.compile(r"\b(for|while|do)\b")

C_IDENT_RE = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b")
C_COMMENTS_AND_STRINGS_RE = re.compile(
    r"//.*?$|/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'",
    re.DOTALL | re.MULTILINE,
)
FOR_HEADER_RE = re.compile(r"\bfor\s*\(([^;]*);([^;]*);([^\)]*)\)")

PRIMITIVE_TYPES = {
    "int", "long", "short", "char", "float", "double",
    "unsigned int", "unsigned long", "unsigned char", "unsigned short",
    "signed int", "signed long", "signed char", "signed short",
    "long long", "unsigned long long", "signed long long",
    "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "size_t", "ssize_t", "ptrdiff_t", "bool", "_Bool"
}

STDLIB_CALL_RE = re.compile(
    r"\b(malloc|calloc|realloc|free|printf|fprintf|sprintf|snprintf|scanf|fscanf|puts|putchar|getchar|memcpy|memmove|memset|memcmp|strlen|strcpy|strncpy|strcmp|exit|abort)\s*\("
)
USER_FUNC_CALL_RE = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(")


# ==============================================================================
# Session-Level DWARF Type Cache Schema
# ==============================================================================

@dataclass
class DwarfTypeEntry:
    kind: str  # "primitive", "primitive_ptr", "primitive_ptr_array", "struct_val", "struct_ptr", "struct_ptr_array", "other"
    target_type: str
    fields: Dict[str, str] = field(default_factory=dict)
    field_order: List[str] = field(default_factory=list)
    has_struct_links: Optional[bool] = None


# ==============================================================================
# Clean Pydantic Data Contract (With Unified 2D Matrix Support)
# ==============================================================================

class ArraySnapshot(BaseModel):
    name: str
    type: str
    kind: str = "array"  # "array" | "matrix"
    dimensions: Optional[List[int]] = None
    rows: Optional[List[List[Any]]] = None
    element_type: str = ""
    is_compound: bool = False
    capacity: Optional[int] = None
    elements: List[Any] = Field(default_factory=list)
    active_indices: Dict[str, int] = Field(default_factory=dict)


class GraphNode(BaseModel):
    id: str
    type: str
    c_type: str = ""
    label: str
    fields: Dict[str, Any]
    is_active: bool
    is_freed: bool = False
    pointers: List[str] = Field(default_factory=list)
    self_ref_order: List[str] = Field(default_factory=list)


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str
    field_order_idx: int = 0


class GraphSnapshot(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]


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


def format_scalar_val(val: Any) -> Any:
    if is_infinity_like(val):
        return "∞"
    return val


def split_top_level_braces(inner: str) -> List[str]:
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
            base_raw = rep_match.group(1).strip()
            count = min(int(rep_match.group(2)), max_elems)
            if base_raw.startswith("{") and base_raw.endswith("}"):
                elements.extend([base_raw] * count)
            else:
                elements.extend([parse_scalar(base_raw)] * count)
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
# High-Throughput DWARF/GDB-MI Session Controller (`GDBTracer`)
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
        self._full_clean_source: str = ""
        self._user_source_identifiers: Set[str] = set()

        if self.source_path.exists():
            raw_text = self.source_path.read_text(encoding="utf-8", errors="replace")
            self._source_lines.extend(raw_text.splitlines())
            self._full_clean_source = C_COMMENTS_AND_STRINGS_RE.sub(" ", raw_text)
            for m in C_IDENT_RE.finditer(self._full_clean_source):
                tok = m.group(1)
                if tok not in C_SYNTAX_KEYWORDS:
                    self._user_source_identifiers.add(tok)

        self._type_cache: Dict[str, DwarfTypeEntry] = {}
        self._freed_addresses: Set[str] = set()
        self._freed_struct_types: Dict[str, str] = {}
        self._live_heap_structs: Dict[str, str] = {}
        self._last_valid_node_fields: Dict[str, Dict[str, Any]] = {}

        # Per-function variable snapshot cache for user caller frames
        self._frame_vars_by_func: Dict[str, List[Dict[str, str]]] = {}
        self._active_call_stack: List[str] = ["main"]

        # Syntactic analysis caches
        self._syntactic_index_cache: Dict[Tuple[str, str], Set[str]] = {}
        self._func_body_cache: Dict[str, str] = {}
        self._func_complexity_cache: Dict[str, bool] = {}
        self._alloc_bound_expr_cache: Dict[str, List[str]] = {}
        self._self_indexed_buffers_cache: Dict[str, bool] = {}

        self._current_line: int = 0
        self._current_file: str = ""
        self._current_func: str = "main"
        self._token_counter: int = 100

    @staticmethod
    def _is_system_or_runtime_symbol(var_name: str, var_type: str = "") -> bool:
        """
        Strictly filters out internal C runtime, glibc, pthread, and DWARF `@entry`
        pseudo-variables (`argv@entry`, `unwind_buf`, `cancel_jmp_buf`, `__libc_*`).
        """
        if not var_name:
            return True
        base_name = var_name.split(":")[-1].strip()
        if "@" in var_name or "@" in base_name:
            return True
        if base_name.startswith("_"):
            return True
        combined = f"{base_name} {var_type}".lower()
        for noise in SYSTEM_RUNTIME_SUBSTRINGS:
            if noise.lower() in combined:
                return True
        return False

    def _is_valid_user_symbol(self, var_name: str, var_type: str = "") -> bool:
        """
        Returns True ONLY if `var_name` is a genuine user-declared variable in `target.c`
        and not a compiler/glibc internal symbol.
        """
        if self._is_system_or_runtime_symbol(var_name, var_type):
            return False
        base_name = var_name.split(":")[-1].split("[")[0].split("->")[0].split(".")[0].strip()
        if self._user_source_identifiers and base_name not in self._user_source_identifiers:
            return False
        return True

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
            time_to_check_for_additional_output_sec=0.001,
        )
        self.gdb.get_gdb_response(timeout_sec=1.0, raise_error_on_timeout=False)

        startup_cmds = [
            "-gdb-set disable-randomization on",
            "-gdb-set print pretty off",
            "-gdb-set print address on",
            "-gdb-set print symbol off",
            "-gdb-set print elements 256",
            "-gdb-set print repeats unlimited",
            "-gdb-set confirm off",
            "-gdb-set pagination off",
        ]
        if self.stdin_path and self.stdin_path.exists():
            startup_cmds.append(f'-gdb-set args < "{self.stdin_path}"')
        startup_cmds.append("-break-insert main")

        self._cmd("\n".join(startup_cmds))
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

    def _eval_expr_batch(self, exprs: List[str]) -> Dict[str, Optional[str]]:
        if not exprs:
            return {}
        if len(exprs) == 1:
            return {exprs[0]: self._eval_expr(exprs[0])}

        unique_exprs = list(dict.fromkeys(exprs))
        token_to_expr: Dict[int, str] = {}
        batched_lines: List[str] = []

        for expr in unique_exprs:
            self._token_counter += 1
            tok = self._token_counter
            token_to_expr[tok] = expr
            escaped = expr.replace('"', '\\"')
            batched_lines.append(f'{tok}-data-evaluate-expression "{escaped}"')

        responses = self._cmd("\n".join(batched_lines))
        results: Dict[str, Optional[str]] = {e: None for e in unique_exprs}

        for r in responses:
            if r.get("type") == "result":
                tok_val = r.get("token")
                if tok_val is not None:
                    try:
                        tok_int = int(tok_val)
                    except (ValueError, TypeError):
                        continue
                    expr_key = token_to_expr.get(tok_int)
                    if expr_key is not None and r.get("message") == "done":
                        payload = r.get("payload", {})
                        if isinstance(payload, dict) and "value" in payload:
                            val = str(payload["value"])
                            if "Cannot access memory" not in val and "<optimized out>" not in val:
                                results[expr_key] = val

        return results

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

                    if func in SYSTEM_ENTRY_FUNCTIONS or func.startswith("_"):
                        return True

                    prev_func = self._current_func
                    self._current_func = func or "main"
                    self._current_file = Path(file_raw).name if file_raw else ""
                    try:
                        self._current_line = int(line_raw)
                    except (ValueError, TypeError):
                        self._current_line = 0

                    if self._current_func != prev_func:
                        if self._current_func in self._active_call_stack:
                            idx = self._active_call_stack.index(self._current_func)
                            for popped_fn in self._active_call_stack[idx + 1 :]:
                                self._frame_vars_by_func.pop(popped_fn, None)
                            self._active_call_stack = self._active_call_stack[: idx + 1]
                        else:
                            self._active_call_stack.append(self._current_func)
                return False
        return False

    def _record_pending_free_on_current_line(self) -> None:
        if 1 <= self._current_line < len(self._source_lines):
            src_line = self._source_lines[self._current_line].split("//")[0]
            free_exprs = [
                m.group(1).strip() for m in FREE_CALL_RE.finditer(src_line)
            ]
            if free_exprs:
                eval_map = self._eval_expr_batch(free_exprs)
                for raw_addr in eval_map.values():
                    addr = extract_hex_address(raw_addr or "")
                    if addr and self._is_valid_heap_or_data_address(addr):
                        self._freed_addresses.add(addr)
                        if addr in self._live_heap_structs:
                            self._freed_struct_types[addr] = self._live_heap_structs[addr]

    def _is_declared_on_current_line(self, var_name: str, line_num: int) -> bool:
        """
        Returns True ONLY if `var_name` is being declared AND initialized with `=`
        for the very first time on `line_num` (so its RHS has not executed yet).
        Never matches uninitialized array declarations (`int mat[3][3];`) or
        statements starting with `else`/`return`.
        """
        if not (1 <= line_num < len(self._source_lines)):
            return False
        src_line = self._source_lines[line_num].split("//")[0].strip()
        if src_line.startswith(("for ", "for(", "while ", "while(", "if ", "if(", "else ", "return ")):
            return False

        m = re.match(
            rf"^(struct\s+[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s+|\s*\*+\s*)\b{re.escape(var_name)}\s*(?:\[[^\]]*\])*\s*=",
            src_line,
        )
        if not m:
            return False
        type_tok = m.group(1).strip()
        if type_tok in C_CONTROL_KEYWORDS:
            return False
        return True

    # ==========================================================================
    # Algorithmic Complexity Step Filter
    # ==========================================================================

    def _extract_function_body_by_name(
        self, func_name: str, anchor_line: Optional[int] = None
    ) -> str:
        if func_name in self._func_body_cache:
            return self._func_body_cache[func_name]

        total_lines = len(self._source_lines)
        if total_lines <= 1:
            return ""

        func_def_re = re.compile(rf"\b{re.escape(func_name)}\s*\([^\)]*\)\s*\{{?")
        func_header_line: Optional[int] = None

        if anchor_line is not None and 1 <= anchor_line < total_lines:
            for line_idx in range(anchor_line, 0, -1):
                line_clean = self._source_lines[line_idx].split("//")[0].strip()
                if func_def_re.search(line_clean) and not line_clean.endswith(";"):
                    func_header_line = line_idx
                    break

        if func_header_line is None:
            for line_idx in range(1, total_lines):
                line_clean = self._source_lines[line_idx].split("//")[0].strip()
                if func_def_re.search(line_clean) and not line_clean.endswith(";"):
                    next_line = (
                        self._source_lines[line_idx + 1].split("//")[0].strip()
                        if line_idx + 1 < total_lines
                        else ""
                    )
                    if "{" in line_clean or next_line.startswith("{"):
                        func_header_line = line_idx
                        break

        if func_header_line is None:
            self._func_body_cache[func_name] = ""
            return ""

        raw_chunk_lines: List[str] = []
        brace_depth = 0
        saw_open_brace = False

        for line_idx in range(func_header_line, total_lines):
            raw_line = self._source_lines[line_idx]
            raw_chunk_lines.append(raw_line)
            clean_line = C_COMMENTS_AND_STRINGS_RE.sub(" ", raw_line)
            for ch in clean_line:
                if ch == "{":
                    brace_depth += 1
                    saw_open_brace = True
                elif ch == "}":
                    brace_depth -= 1
            if saw_open_brace and brace_depth <= 0:
                break

        raw_body = "\n".join(raw_chunk_lines)
        cleaned_body = C_COMMENTS_AND_STRINGS_RE.sub(" ", raw_body)
        first_brace = cleaned_body.find("{")
        inner_body = cleaned_body[first_brace:] if first_brace != -1 else cleaned_body
        self._func_body_cache[func_name] = inner_body
        return inner_body

    def _is_complex_user_function(self, func_name: str) -> bool:
        if func_name in self._func_complexity_cache:
            return self._func_complexity_cache[func_name]

        body = self._extract_function_body_by_name(func_name)
        if not body:
            self._func_complexity_cache[func_name] = False
            return False

        has_loop = bool(C_LOOP_STATEMENT_RE.search(body))
        self_call_re = re.compile(rf"\b{re.escape(func_name)}\s*\(")
        has_recursion = bool(self_call_re.search(body))

        is_complex = has_loop or has_recursion
        self._func_complexity_cache[func_name] = is_complex
        return is_complex

    def _should_step_into_current_line(self) -> bool:
        if not (1 <= self._current_line < len(self._source_lines)):
            return False
        src_line = self._source_lines[self._current_line].split("//")[0].strip()
        if not src_line:
            return False

        if STDLIB_CALL_RE.search(src_line):
            return False

        for match in USER_FUNC_CALL_RE.finditer(src_line):
            fn_name = match.group(1)
            if fn_name in C_CONTROL_KEYWORDS or fn_name in C_SYNTAX_KEYWORDS:
                continue
            if self._is_complex_user_function(fn_name):
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
                and self._current_func not in SYSTEM_ENTRY_FUNCTIONS
            ):
                return True

            if self._current_func in SYSTEM_ENTRY_FUNCTIONS or self._current_func.startswith("_"):
                return False

            fin_res = self._cmd("-exec-finish")
            if self._update_stop_state(fin_res):
                return False

        return (
            self._current_file == self.source_path.name
            and self._current_line > 0
            and self._current_func not in SYSTEM_ENTRY_FUNCTIONS
        )

    # ==========================================================================
    # Syntactic Subscript, Multi-Dimensional Index & Forest Proof Engine
    # ==========================================================================

    @staticmethod
    def _extract_identifiers_from_expr(expr: str) -> Set[str]:
        idents: Set[str] = set()
        for match in C_IDENT_RE.finditer(expr):
            token = match.group(1)
            if token in C_SYNTAX_KEYWORDS:
                continue
            end_pos = match.end()
            trailing = expr[end_pos:].lstrip()
            if trailing.startswith("("):
                continue
            idents.add(token)
        return idents

    def _is_syntactically_self_indexed_buffer(self, buf_leaf_name: str) -> bool:
        clean_leaf = buf_leaf_name.split("->")[-1].split(".")[-1].strip()
        if clean_leaf in self._self_indexed_buffers_cache:
            return self._self_indexed_buffers_cache[clean_leaf]

        esc = re.escape(clean_leaf)
        src = self._full_clean_source

        nested_re = re.compile(rf"\b{esc}\s*\[[^\]]*\b{esc}\s*\[")
        ident_init_re = re.compile(rf"\b{esc}\s*\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\]\s*=\s*\1\s*;")
        self_cmp_re = re.compile(rf"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:!=|==)\s*[^;]*\b{esc}\s*\[\s*\1\s*\]")

        is_forest_buf = bool(
            nested_re.search(src)
            or ident_init_re.search(src)
            or self_cmp_re.search(src)
        )
        self._self_indexed_buffers_cache[clean_leaf] = is_forest_buf
        return is_forest_buf

    def _get_syntactically_proven_indices(
        self,
        func_name: str,
        anchor_line: int,
        array_name: str,
    ) -> Set[str]:
        clean_arr_name = array_name.strip()
        cache_key = (func_name, clean_arr_name)
        if cache_key in self._syntactic_index_cache:
            return self._syntactic_index_cache[cache_key]

        body = self._extract_function_body_by_name(func_name, anchor_line)
        if not body:
            self._syntactic_index_cache[cache_key] = set()
            return set()

        escaped_full = re.escape(clean_arr_name)
        base_leaf = clean_arr_name.split("->")[-1].split(".")[-1].strip()
        escaped_leaf = re.escape(base_leaf)

        proven_indices: Set[str] = set()
        owner_tokens: Set[str] = set(clean_arr_name.replace("->", ".").split("."))

        # Proof 1: Direct 1D & Multi-Dimensional Subscript Access (`arr[i]` and `mat[i][j]`)
        subscript_chain_pattern = re.compile(
            rf"(?:{escaped_full}|\b{escaped_leaf})((?:\s*\[[^\]]+\])+)"
        )
        inner_bracket_re = re.compile(r"\[([^\]]+)\]")
        for match in subscript_chain_pattern.finditer(body):
            chain_str = match.group(1)
            for sub_m in inner_bracket_re.finditer(chain_str):
                for ident in self._extract_identifiers_from_expr(sub_m.group(1)):
                    if ident not in owner_tokens:
                        proven_indices.add(ident)

        # Proof 2: Pointer Offset Dereference `*(arr + offset_expr)`
        ptr_arith_pattern = re.compile(
            rf"\*\s*\(\s*(?:(?:{escaped_full}|\b{escaped_leaf})\s*[\+\-]\s*([^\)]+)|([^\)]+?)\s*\+\s*(?:{escaped_full}|\b{escaped_leaf}))\s*\)"
        )
        for match in ptr_arith_pattern.finditer(body):
            offset_expr = match.group(1) or match.group(2) or ""
            for ident in self._extract_identifiers_from_expr(offset_expr):
                if ident not in owner_tokens:
                    proven_indices.add(ident)

        # Proof 3: Loop Induction Variable in `for (init; cond; step)` when `arr` is in scope
        if re.search(rf"(?:{escaped_full}|\b{escaped_leaf})\b", body):
            for match in FOR_HEADER_RE.finditer(body):
                cond_part = match.group(2)
                step_part = match.group(3)
                cond_idents = self._extract_identifiers_from_expr(cond_part)
                step_idents = self._extract_identifiers_from_expr(step_part)
                for ind_var in cond_idents.intersection(step_idents):
                    if ind_var not in owner_tokens:
                        proven_indices.add(ind_var)

        # Proof 4: Transitive Index Dataflow
        assignment_re = re.compile(
            r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+|-|\*|/)?=(?!=)\s*([^;]+);"
        )
        assignments: List[Tuple[str, str, Set[str]]] = []
        for match in assignment_re.finditer(body):
            lhs_var = match.group(1)
            rhs_expr = match.group(2).strip()
            if lhs_var in C_SYNTAX_KEYWORDS or lhs_var in owner_tokens:
                continue
            if subscript_chain_pattern.search(rhs_expr) or ptr_arith_pattern.search(rhs_expr):
                continue
            rhs_idents = self._extract_identifiers_from_expr(rhs_expr) - owner_tokens
            assignments.append((lhs_var, rhs_expr, rhs_idents))

        for _ in range(2):
            newly_proven: Set[str] = set()
            for lhs_var, _, rhs_idents in assignments:
                if not rhs_idents:
                    continue
                if lhs_var in proven_indices:
                    newly_proven.update(rhs_idents)
                elif rhs_idents.intersection(proven_indices):
                    newly_proven.add(lhs_var)
            proven_indices.update(newly_proven)

        mutated_vars: Set[str] = {lhs for lhs, _, _ in assignments}
        for mut_match in re.finditer(
            r"(?:\+\+|--)\s*([a-zA-Z_][a-zA-Z0-9_]*)|([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+\+|--|\+=|-=)",
            body,
        ):
            mv = mut_match.group(1) or mut_match.group(2)
            if mv:
                mutated_vars.add(mv)

        direct_subscript_vars: Set[str] = set()
        for match in subscript_chain_pattern.finditer(body):
            for sub_m in inner_bracket_re.finditer(match.group(1)):
                direct_subscript_vars.update(
                    self._extract_identifiers_from_expr(sub_m.group(1))
                )

        filtered_indices = {
            v
            for v in proven_indices
            if v in direct_subscript_vars or v in mutated_vars
        }

        self._syntactic_index_cache[cache_key] = filtered_indices
        return filtered_indices

    def _collect_active_indices(
        self,
        scalar_ints: Dict[str, int],
        array_len: int,
        array_name: str = "",
    ) -> Dict[str, int]:
        if not array_name or array_len <= 0:
            return {}

        proven_index_names = self._get_syntactically_proven_indices(
            func_name=self._current_func,
            anchor_line=self._current_line,
            array_name=array_name,
        )

        active: Dict[str, int] = {}
        for var_name, val in scalar_ints.items():
            if var_name not in proven_index_names:
                continue
            if -1 <= val <= array_len:
                active[var_name] = val

        return active

    def _get_global_field_subscript_cursors(self, field_name: str) -> Set[str]:
        global_cache_key = ("__GLOBAL_STRUCT_BUF__", field_name)
        if global_cache_key not in self._syntactic_index_cache:
            sub_re = re.compile(rf"(?:->|\.)\s*{re.escape(field_name)}\s*\[([^\]]+)\]")
            global_sub_idents: Set[str] = set()
            for m in sub_re.finditer(self._full_clean_source):
                global_sub_idents.update(self._extract_identifiers_from_expr(m.group(1)))
            self._syntactic_index_cache[global_cache_key] = global_sub_idents
        return self._syntactic_index_cache[global_cache_key]

    def _collect_struct_buffer_indices(
        self,
        owner_name: str,
        field_name: str,
        sister_scalars: Dict[str, int],
        frame_scalar_ints: Dict[str, int],
        array_len: int,
    ) -> Dict[str, int]:
        full_arr_name = f"{owner_name}->{field_name}"
        active: Dict[str, int] = {}

        proven_struct_cursors = self._get_global_field_subscript_cursors(field_name)

        for s_name, s_val in sister_scalars.items():
            if s_name in proven_struct_cursors and -1 <= s_val <= array_len:
                active[s_name] = s_val

        local_proven = self._collect_active_indices(
            scalar_ints=frame_scalar_ints,
            array_len=array_len,
            array_name=full_arr_name,
        )
        for k, v in local_proven.items():
            if k not in active:
                active[k] = v

        return active

    def _infer_pointer_buffer_length(
        self,
        ptr_leaf_name: str,
        sister_scalars: Dict[str, int],
        frame_scalars: Dict[str, int],
    ) -> Optional[int]:
        if ptr_leaf_name not in self._alloc_bound_expr_cache:
            candidates: List[str] = []
            esc = re.escape(ptr_leaf_name)
            alloc_re = re.compile(
                rf"\b{esc}\s*(?:\[[^\]]+\])?\s*=\s*(?:\([^\)]*\)\s*)?(?:malloc|calloc|realloc)\s*\(\s*([^,\)\*]+)"
            )
            for m in alloc_re.finditer(self._full_clean_source):
                for ident in self._extract_identifiers_from_expr(m.group(1)):
                    if ident not in candidates:
                        candidates.append(ident)

            bound_re = re.compile(rf"<\s*([a-zA-Z_][a-zA-Z0-9_]*)\b")
            for m in bound_re.finditer(self._full_clean_source):
                ident = m.group(1)
                if ident not in C_SYNTAX_KEYWORDS and ident not in candidates:
                    candidates.append(ident)

            self._alloc_bound_expr_cache[ptr_leaf_name] = candidates

        bound_candidates = self._alloc_bound_expr_cache[ptr_leaf_name]
        proven_cursors = self._get_global_field_subscript_cursors(ptr_leaf_name)

        for cand in bound_candidates:
            if cand in sister_scalars and cand not in proven_cursors:
                val = sister_scalars[cand]
                if 1 <= val <= 4096:
                    return min(val, MAX_STRUCT_BUFFER_ELEMENTS)

        non_cursor_sisters = [
            val
            for k, val in sister_scalars.items()
            if k not in proven_cursors and 1 <= val <= 4096
        ]
        if non_cursor_sisters:
            return min(min(non_cursor_sisters), MAX_STRUCT_BUFFER_ELEMENTS)

        local_proven_cursors = self._get_syntactically_proven_indices(
            self._current_func, self._current_line, ptr_leaf_name
        )
        for cand in bound_candidates:
            if cand in frame_scalars and cand not in local_proven_cursors:
                val = frame_scalars[cand]
                if 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val

        if not sister_scalars:
            for k, val in frame_scalars.items():
                if k not in local_proven_cursors and 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val

        for k, val in sister_scalars.items():
            if k in proven_cursors and 0 <= val < MAX_STRUCT_BUFFER_ELEMENTS:
                return val + 1

        return None

    # ==========================================================================
    # Session-Level DWARF Type Cache (`_type_cache`)
    # ==========================================================================

    def _resolve_type_info(self, raw_type: str) -> Tuple[str, str]:
        clean = raw_type.replace("const", "").replace("volatile", "").strip()
        if clean in self._type_cache:
            entry = self._type_cache[clean]
            return (entry.kind, entry.target_type)

        if self._is_system_or_runtime_symbol(clean, clean):
            entry = DwarfTypeEntry(kind="other", target_type=clean)
            self._type_cache[clean] = entry
            return (entry.kind, entry.target_type)

        if clean in PRIMITIVE_TYPES:
            entry = DwarfTypeEntry(kind="primitive", target_type=clean)
            self._type_cache[clean] = entry
            return (entry.kind, entry.target_type)

        if clean.endswith("**"):
            base_no_stars = clean.rstrip("*").strip()
            if base_no_stars in PRIMITIVE_TYPES:
                entry = DwarfTypeEntry(kind="primitive_ptr_array", target_type=base_no_stars)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)
            base_kind, base_resolved = self._resolve_type_info(base_no_stars)
            if base_kind == "struct_val":
                entry = DwarfTypeEntry(kind="struct_ptr_array", target_type=base_resolved)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)

        ptr_match = PTR_TYPE_RE.match(clean)
        if ptr_match:
            base = ptr_match.group(1).strip()
            if base in PRIMITIVE_TYPES:
                entry = DwarfTypeEntry(kind="primitive_ptr", target_type=base)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)
            if base.startswith("struct ") and not base.endswith("*"):
                self._ensure_struct_field_types(base)
                entry = DwarfTypeEntry(kind="struct_ptr", target_type=base)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)
            base_kind, base_resolved = self._resolve_type_info(base)
            if base_kind == "struct_val":
                entry = DwarfTypeEntry(kind="struct_ptr", target_type=base_resolved)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)
            if base_kind == "struct_ptr":
                entry = DwarfTypeEntry(kind="struct_ptr_array", target_type=base_resolved)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)
            if base_kind == "primitive_ptr":
                entry = DwarfTypeEntry(kind="primitive_ptr_array", target_type=base_resolved)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)

        if clean.startswith("struct ") and not clean.endswith("*"):
            fields = self._ensure_struct_field_types(clean)
            entry = DwarfTypeEntry(
                kind="struct_val",
                target_type=clean,
                fields=fields,
                field_order=list(fields.keys()),
            )
            self._type_cache[clean] = entry
            return (entry.kind, entry.target_type)

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
            if self._is_system_or_runtime_symbol(canonical_struct, canonical_struct):
                entry = DwarfTypeEntry(kind="other", target_type=clean)
                self._type_cache[clean] = entry
                return (entry.kind, entry.target_type)

            parsed_fields = self._parse_ptype_fields(full_console)

            if canonical_struct not in self._type_cache:
                self._type_cache[canonical_struct] = DwarfTypeEntry(
                    kind="struct_val",
                    target_type=canonical_struct,
                    fields=parsed_fields,
                    field_order=list(parsed_fields.keys()),
                )
            else:
                self._type_cache[canonical_struct].fields = parsed_fields
                self._type_cache[canonical_struct].field_order = list(parsed_fields.keys())

            brace_end = full_console.rfind("}")
            tail = full_console[brace_end + 1 :].strip() if brace_end != -1 else ""
            if "**" in tail:
                kind = "struct_ptr_array"
            elif "*" in tail:
                kind = "struct_ptr"
            else:
                kind = "struct_val"

            entry = DwarfTypeEntry(
                kind=kind,
                target_type=canonical_struct,
                fields=parsed_fields,
                field_order=list(parsed_fields.keys()),
            )
            self._type_cache[clean] = entry
            return (entry.kind, entry.target_type)

        entry = DwarfTypeEntry(kind="other", target_type=clean)
        self._type_cache[clean] = entry
        return (entry.kind, entry.target_type)

    def _ensure_struct_field_types(self, struct_type: str) -> Dict[str, str]:
        clean = struct_type.replace("const", "").replace("volatile", "").strip()
        if clean in self._type_cache and self._type_cache[clean].fields:
            return self._type_cache[clean].fields

        responses = self._cmd(f"ptype {clean}")
        full_console = "".join(
            r.get("payload", "") for r in responses if r.get("type") == "console"
        )
        parsed_fields = self._parse_ptype_fields(full_console)
        if clean in self._type_cache:
            self._type_cache[clean].fields = parsed_fields
            self._type_cache[clean].field_order = list(parsed_fields.keys())
        else:
            self._type_cache[clean] = DwarfTypeEntry(
                kind="struct_val",
                target_type=clean,
                fields=parsed_fields,
                field_order=list(parsed_fields.keys()),
            )
        return parsed_fields

    @staticmethod
    def _parse_ptype_fields(ptype_output: str) -> Dict[str, str]:
        field_map: Dict[str, str] = {}
        brace_start = ptype_output.find("{")
        brace_end = ptype_output.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            body = ptype_output[brace_start + 1 : brace_end]
            for raw_line in body.splitlines():
                clean_line = re.sub(r"/\*.*?\*/", "", raw_line).strip().rstrip(";")
                if not clean_line:
                    continue
                m = re.match(
                    r"^(.+?[\s\*]+)([a-zA-Z_][a-zA-Z0-9_]*)(\[\d+\])?$", clean_line
                )
                if m:
                    f_type = m.group(1).strip()
                    f_name = m.group(2).strip()
                    arr_suffix = m.group(3) or ""
                    field_map[f_name] = f"{f_type}{arr_suffix}"
        return field_map

    def _has_struct_pointer_links(self, struct_type: str) -> bool:
        clean = struct_type.replace("const", "").replace("volatile", "").strip()
        if clean in self._type_cache and self._type_cache[clean].has_struct_links is not None:
            return bool(self._type_cache[clean].has_struct_links)

        f_types = self._ensure_struct_field_types(clean)
        has_links = False
        for f_decl in f_types.values():
            arr_m = FIXED_ARR_RE.match(f_decl)
            check_t = arr_m.group(1).strip() if arr_m else f_decl
            kind, _ = self._resolve_type_info(check_t)
            if kind in {"struct_ptr", "struct_ptr_array"}:
                has_links = True
                break

        if clean in self._type_cache:
            self._type_cache[clean].has_struct_links = has_links
        return has_links

    def _is_field_pointer_type(
        self, declared_f_type: str, f_name: str, f_val: str
    ) -> Tuple[bool, str, str]:
        clean_type = declared_f_type.replace("const", "").replace("volatile", "").strip()

        if clean_type:
            if clean_type in PRIMITIVE_TYPES and "*" not in clean_type:
                return (False, "primitive", clean_type)

            f_kind, f_target_type = self._resolve_type_info(clean_type)
            if (
                f_kind in {"primitive_ptr", "primitive_ptr_array", "struct_ptr", "struct_ptr_array"}
                or "*" in clean_type
            ):
                return (True, f_kind, f_target_type)
            if f_kind in {"primitive", "struct_val"}:
                return (False, f_kind, f_target_type)

        val_stripped = f_val.strip().lower()
        if val_stripped.startswith("0x") or HEX_ADDR_RE.search(val_stripped):
            return (True, "other", "")

        return (False, "primitive", clean_type or "int")

    def _collect_fast_frame_variables(self) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Harvests variables from the active user frame, strictly discarding any
        glibc/pthread/runtime internal symbols (`@entry`, `unwind_buf`, `__*`, etc.)
        and merging non-shadowed user variables from caller frames.
        """
        var_res = self._cmd("-stack-list-variables --simple-values")
        current_frame_vars: List[Dict[str, str]] = []
        for r in var_res:
            if r.get("type") == "result" and r.get("message") == "done":
                current_frame_vars = r.get("payload", {}).get("variables", [])
                break

        filtered_leaf_vars: List[Dict[str, str]] = []
        for v in current_frame_vars:
            v_name = v.get("name", "")
            v_type = v.get("type", "")
            if not self._is_valid_user_symbol(v_name, v_type):
                continue
            if self._is_declared_on_current_line(v_name, self._current_line):
                continue
            filtered_leaf_vars.append(v)

        if self._current_func not in SYSTEM_ENTRY_FUNCTIONS:
            self._frame_vars_by_func[self._current_func] = filtered_leaf_vars

        merged_vars: List[Dict[str, Any]] = []
        seen_var_names: Set[str] = set()
        seen_pointer_addrs: Set[str] = set()

        for v in filtered_leaf_vars:
            v_name = v.get("name", "")
            seen_var_names.add(v_name)
            addr = extract_hex_address(v.get("value", ""))
            if addr:
                seen_pointer_addrs.add(addr)
            v_copy: Dict[str, Any] = dict(v)
            v_copy["frame_level"] = 0
            merged_vars.append(v_copy)

        for caller_fn in reversed(self._active_call_stack[:-1]):
            if caller_fn in SYSTEM_ENTRY_FUNCTIONS:
                continue
            caller_vars = self._frame_vars_by_func.get(caller_fn, [])
            for v in caller_vars:
                v_name = v.get("name", "")
                v_type = v.get("type", "")
                if not self._is_valid_user_symbol(v_name, v_type):
                    continue
                addr = extract_hex_address(v.get("value", ""))
                if v_name not in seen_var_names:
                    seen_var_names.add(v_name)
                    if addr:
                        seen_pointer_addrs.add(addr)
                    v_copy = dict(v)
                    v_copy["frame_level"] = 1
                    merged_vars.append(v_copy)
                elif addr and addr not in seen_pointer_addrs:
                    seen_pointer_addrs.add(addr)
                    v_copy = dict(v)
                    v_copy["name"] = f"{caller_fn}:{v_name}"
                    v_copy["frame_level"] = 1
                    merged_vars.append(v_copy)

        return (list(self._active_call_stack), merged_vars)

    def _serialize_compound_struct_element(
        self, raw_struct_str: str, addr: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        ef = parse_gdb_struct_body(raw_struct_str)
        if not ef:
            return None

        fields_dict: Dict[str, Any] = {}
        scalar_pairs: List[Tuple[str, Any]] = []

        for k, v_raw in ef.items():
            if extract_hex_address(v_raw):
                continue
            parsed = format_scalar_val(parse_scalar(v_raw))
            fields_dict[k] = parsed
            scalar_pairs.append((k, parsed))

        if not scalar_pairs:
            return None

        label_str = ", ".join(f"{k}: {v}" for k, v in scalar_pairs)
        first_k, first_v = scalar_pairs[0]
        last_v = scalar_pairs[-1][1]

        record: Dict[str, Any] = {
            "fields": fields_dict,
            "label": label_str,
            "value": last_v,
            "secondary": f"{first_k}={first_v}",
        }
        if addr:
            record["address"] = addr
        return record

    def inspect_state(self) -> Optional[ExecutionSnapshot]:
        self._check_budget()
        if (
            self._current_file != self.source_path.name
            or self._current_line <= 0
            or self._current_func in SYSTEM_ENTRY_FUNCTIONS
        ):
            return None

        call_stack, raw_vars = self._collect_fast_frame_variables()

        locals_out: Dict[str, Any] = {}
        scalar_ints: Dict[str, int] = {}
        leaf_scalar_ints: Dict[str, int] = {}
        active_struct_ptrs: Dict[str, Tuple[str, str]] = {}
        raw_array_vars: List[Tuple[str, str, int, int]] = []
        raw_2d_array_vars: List[Tuple[str, str, int, int, int]] = []
        raw_ptr_vars: List[Tuple[str, str, str, int]] = []
        raw_2d_ptr_vars: List[Tuple[str, str, str, int]] = []
        raw_struct_ptr_array_vars: List[Tuple[str, str, str, int]] = []

        # ----------------------------------------------------------------------
        # Pass 1: Classify all user-scope variables
        # ----------------------------------------------------------------------
        for v in raw_vars:
            v_name = v.get("name", "")
            v_type = v.get("type", "").strip()
            v_val = v.get("value", "")
            f_level = int(v.get("frame_level", 0))

            if not self._is_valid_user_symbol(v_name, v_type):
                continue

            # 1A: Fixed 2D stack array (`int mat[3][3]`)
            arr_2d_match = FIXED_2D_ARR_RE.match(v_type)
            if arr_2d_match:
                elem_type = arr_2d_match.group(1).strip()
                rows = min(int(arr_2d_match.group(2)), MAX_MATRIX_DIM)
                cols = min(int(arr_2d_match.group(3)), MAX_MATRIX_DIM)
                if f_level == 0:
                    raw_2d_array_vars.append((v_name, elem_type, rows, cols, f_level))
                continue

            # 1B: Fixed 1D stack array (`int values[20]`)
            arr_match = FIXED_ARR_RE.match(v_type)
            if arr_match:
                elem_type = arr_match.group(1).strip()
                arr_len = min(int(arr_match.group(2)), MAX_ARRAY_ELEMENTS)
                if f_level == 0:
                    raw_array_vars.append((v_name, elem_type, arr_len, f_level))
                continue

            type_kind, resolved_target = self._resolve_type_info(v_type)

            # 1C: Top-Level Struct Pointer Array (`UFNode **nodes`)
            if type_kind == "struct_ptr_array":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr and addr not in self._freed_addresses:
                    raw_struct_ptr_array_vars.append((v_name, resolved_target, addr, f_level))
                continue

            # 1D: Top-Level 2D Primitive Pointer Matrix (`int **mat`)
            if type_kind == "primitive_ptr_array":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr and addr not in self._freed_addresses:
                    raw_2d_ptr_vars.append((v_name, resolved_target, addr, f_level))
                continue

            # 1E: Single Struct Pointer (`BSTNode *root`, `union_find uf`)
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
                    if v_name.split(":")[-1] in line_txt and (
                        "malloc" in line_txt
                        or "calloc" in line_txt
                        or "realloc" in line_txt
                        or "=" in line_txt
                    ):
                        self._freed_addresses.discard(addr)
                        self._freed_struct_types.pop(addr, None)

                active_struct_ptrs[v_name] = (addr, resolved_target)
                self._live_heap_structs[addr] = resolved_target
                continue

            # 1F: 1D Primitive Pointer (`int *dist`, `int *arr`)
            if type_kind == "primitive_ptr":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr:
                    raw_ptr_vars.append((v_name, resolved_target, addr, f_level))
                continue

            # 1G: Struct by Value on User Stack
            if type_kind == "struct_val" and f_level == 0:
                if not self._is_system_or_runtime_symbol(resolved_target, resolved_target):
                    addr_raw = self._eval_expr(f"&{v_name}")
                    addr = extract_hex_address(addr_raw or "")
                    if addr:
                        active_struct_ptrs[v_name] = (addr, resolved_target)
                        locals_out[v_name] = addr
                continue

            # 1H: Scalar Primitives
            parsed_val = parse_scalar(v_val)
            if isinstance(parsed_val, int):
                scalar_ints[v_name] = parsed_val
                if f_level == 0:
                    leaf_scalar_ints[v_name] = parsed_val
                    locals_out[v_name] = format_scalar_val(parsed_val)
            elif f_level == 0:
                locals_out[v_name] = parsed_val

        # ----------------------------------------------------------------------
        # Pass 1.5: Expand Top-Level `T**` Struct Pointer Tables (`UFNode **nodes`)
        # ----------------------------------------------------------------------
        arrays_snapshot: List[ArraySnapshot] = []

        for tbl_name, target_s_type, tbl_addr, _ in raw_struct_ptr_array_vars:
            if not self._is_valid_heap_or_data_address(tbl_addr):
                continue
            clean_tbl_name = tbl_name.split(":")[-1]
            tbl_len = self._infer_pointer_buffer_length(
                ptr_leaf_name=clean_tbl_name,
                sister_scalars={},
                frame_scalars=scalar_ints,
            )
            if not tbl_len or not (1 <= tbl_len <= MAX_STRUCT_BUFFER_ELEMENTS):
                continue

            if self._has_struct_pointer_links(target_s_type):
                ptr_slice_raw = self._eval_expr(f"*(void *[{tbl_len}]*)({tbl_addr})")
                if ptr_slice_raw:
                    elem_ptrs = parse_gdb_array(ptr_slice_raw, max_elems=tbl_len)
                    for idx, raw_ep in enumerate(elem_ptrs):
                        ep_addr = extract_hex_address(str(raw_ep))
                        if (
                            ep_addr
                            and self._is_valid_heap_or_data_address(ep_addr)
                            and ep_addr not in self._freed_addresses
                        ):
                            active_struct_ptrs[f"{clean_tbl_name}[{idx}]"] = (
                                ep_addr,
                                target_s_type,
                            )
                            self._live_heap_structs[ep_addr] = target_s_type
            else:
                comp_snap = self._extract_struct_array_field(
                    owner_name=clean_tbl_name,
                    field_name="",
                    array_base_addr=tbl_addr,
                    elem_struct_type=target_s_type,
                    is_pointer_array=True,
                    sister_scalars={},
                    leaf_scalar_ints=leaf_scalar_ints,
                    all_scalar_ints=scalar_ints,
                )
                if comp_snap is not None:
                    comp_snap.name = clean_tbl_name
                    arrays_snapshot.append(comp_snap)

        # ----------------------------------------------------------------------
        # Pass 2: Evaluate 1D Arrays & Unified 2D Matrices (`kind: "matrix"`)
        # ----------------------------------------------------------------------
        array_eval_specs: List[Tuple[str, str, str, int, bool, str]] = []

        for arr_name, elem_type, arr_len, _ in raw_array_vars:
            elem_kind, elem_resolved = self._resolve_type_info(elem_type)
            is_comp = elem_kind == "struct_val" and not self._has_struct_pointer_links(elem_resolved)
            array_eval_specs.append(
                (arr_name, arr_name, elem_type, arr_len, is_comp, elem_resolved if is_comp else elem_type)
            )

        for ptr_name, elem_type, addr, _ in raw_ptr_vars:
            if (
                addr in self._freed_addresses
                or not self._is_valid_heap_or_data_address(addr)
            ):
                continue
            inferred_len = self._infer_pointer_buffer_length(
                ptr_leaf_name=ptr_name.split(":")[-1],
                sister_scalars={},
                frame_scalars=scalar_ints,
            )
            if inferred_len and 1 <= inferred_len <= MAX_ARRAY_ELEMENTS:
                deref_expr = f"*({elem_type}[{inferred_len}]*)({addr})"
                array_eval_specs.append(
                    (ptr_name, deref_expr, elem_type, inferred_len, False, elem_type)
                )

        if array_eval_specs:
            batch_exprs = [spec[1] for spec in array_eval_specs]
            batch_results = self._eval_expr_batch(batch_exprs)

            for arr_name, expr_key, elem_type, cap_len, is_comp, resolved_el_type in array_eval_specs:
                expr_val = batch_results.get(expr_key)
                if not expr_val:
                    continue
                raw_items = parse_gdb_array(expr_val, max_elems=cap_len)
                if is_comp:
                    compound_elems: List[Dict[str, Any]] = []
                    for item_str in raw_items:
                        if isinstance(item_str, str) and item_str.startswith("{"):
                            rec = self._serialize_compound_struct_element(item_str)
                            if rec:
                                compound_elems.append(rec)
                    if compound_elems:
                        active_idx = self._collect_active_indices(
                            leaf_scalar_ints, len(compound_elems), array_name=arr_name
                        )
                        arrays_snapshot.append(
                            ArraySnapshot(
                                name=arr_name,
                                type=elem_type,
                                kind="array",
                                element_type=resolved_el_type,
                                is_compound=True,
                                capacity=cap_len,
                                elements=compound_elems,
                                active_indices=active_idx,
                            )
                        )
                else:
                    elements = [format_scalar_val(x) for x in raw_items]
                    if elements:
                        active_idx = self._collect_active_indices(
                            leaf_scalar_ints, len(elements), array_name=arr_name
                        )
                        arrays_snapshot.append(
                            ArraySnapshot(
                                name=arr_name,
                                type=elem_type,
                                kind="array",
                                element_type=resolved_el_type,
                                is_compound=False,
                                capacity=cap_len,
                                elements=elements,
                                active_indices=active_idx,
                            )
                        )

        # 2B: Unified Fixed 2D Stack Matrices (`int mat[3][3]`)
        for mat_name, elem_type, rows, cols, _ in raw_2d_array_vars:
            mat_val = self._eval_expr(mat_name)
            if not mat_val:
                continue
            row_strings = parse_gdb_array(mat_val, max_elems=rows)
            parsed_rows: List[List[Any]] = []
            for r_str in row_strings:
                if isinstance(r_str, str) and r_str.startswith("{"):
                    row_elems = [
                        format_scalar_val(x)
                        for x in parse_gdb_array(r_str, max_elems=cols)
                    ]
                    parsed_rows.append(row_elems)
                elif isinstance(r_str, (int, float)):
                    parsed_rows.append([format_scalar_val(r_str)] * cols)

            if parsed_rows:
                active_idx = self._collect_active_indices(
                    leaf_scalar_ints, max(rows, cols), array_name=mat_name
                )
                arrays_snapshot.append(
                    ArraySnapshot(
                        name=mat_name,
                        type=f"{elem_type}[{rows}][{cols}]",
                        kind="matrix",
                        dimensions=[len(parsed_rows), cols],
                        rows=parsed_rows,
                        element_type=elem_type,
                        is_compound=False,
                        capacity=len(parsed_rows) * cols,
                        elements=parsed_rows,
                        active_indices=active_idx,
                    )
                )

        # 2C: Unified Heap 2D Pointer Matrices (`int **mat`)
        for mat_name, elem_type, mat_addr, _ in raw_2d_ptr_vars:
            if not self._is_valid_heap_or_data_address(mat_addr):
                continue
            clean_mat = mat_name.split(":")[-1]
            rows_len = self._infer_pointer_buffer_length(
                ptr_leaf_name=clean_mat,
                sister_scalars={},
                frame_scalars=scalar_ints,
            )
            if not rows_len or not (1 <= rows_len <= MAX_MATRIX_DIM):
                continue
            non_cursor_ints = [
                v
                for k, v in scalar_ints.items()
                if k not in self._get_syntactically_proven_indices(self._current_func, self._current_line, clean_mat)
                and 1 <= v <= MAX_MATRIX_DIM
            ]
            cols_len = non_cursor_ints[-1] if non_cursor_ints else rows_len

            row_ptrs_raw = self._eval_expr(f"*(void *[{rows_len}]*)({mat_addr})")
            if not row_ptrs_raw:
                continue
            row_ptrs = parse_gdb_array(row_ptrs_raw, max_elems=rows_len)
            row_expr_map: Dict[int, str] = {}
            for r_idx, rp in enumerate(row_ptrs):
                rp_addr = extract_hex_address(str(rp))
                if (
                    rp_addr
                    and self._is_valid_heap_or_data_address(rp_addr)
                    and rp_addr not in self._freed_addresses
                ):
                    row_expr_map[r_idx] = f"*({elem_type}[{cols_len}]*)({rp_addr})"

            if row_expr_map:
                batch_rows = self._eval_expr_batch(list(row_expr_map.values()))
                parsed_rows = []
                for r_idx in sorted(row_expr_map.keys()):
                    r_val_str = batch_rows.get(row_expr_map[r_idx])
                    if r_val_str:
                        row_elems = [
                            format_scalar_val(x)
                            for x in parse_gdb_array(r_val_str, max_elems=cols_len)
                        ]
                        parsed_rows.append(row_elems)
                if parsed_rows:
                    active_idx = self._collect_active_indices(
                        leaf_scalar_ints, max(rows_len, cols_len), array_name=clean_mat
                    )
                    arrays_snapshot.append(
                        ArraySnapshot(
                            name=clean_mat,
                            type=f"{elem_type}[{len(parsed_rows)}][{cols_len}]",
                            kind="matrix",
                            dimensions=[len(parsed_rows), cols_len],
                            rows=parsed_rows,
                            element_type=elem_type,
                            is_compound=False,
                            capacity=len(parsed_rows) * cols_len,
                            elements=parsed_rows,
                            active_indices=active_idx,
                        )
                    )

        # ----------------------------------------------------------------------
        # Pass 3: Pipelined DWARF Pointer-Mesh Crawler & Embedded Struct Buffers
        # ----------------------------------------------------------------------
        graph_snapshot, embedded_arrays = self._crawl_pointer_graph(
            active_struct_ptrs, leaf_scalar_ints, scalar_ints
        )
        arrays_snapshot.extend(embedded_arrays)

        # ----------------------------------------------------------------------
        # Pass 4: Agnostic Forest / Index-Buffer Graph Projection
        # ----------------------------------------------------------------------
        if len(graph_snapshot.edges) == 0:
            forest_graph = self._try_project_index_forest_graph(
                arrays_snapshot, leaf_scalar_ints
            )
            if forest_graph is not None:
                graph_snapshot = forest_graph

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

    def _try_project_index_forest_graph(
        self,
        arrays_snapshot: List[ArraySnapshot],
        leaf_scalar_ints: Dict[str, int],
    ) -> Optional[GraphSnapshot]:
        for arr in arrays_snapshot:
            if arr.is_compound or arr.kind == "matrix":
                continue
            N = len(arr.elements)
            if not (2 <= N <= MAX_GRAPH_NODES):
                continue
            if not self._is_syntactically_self_indexed_buffer(arr.name):
                continue

            int_elems: List[int] = []
            valid_domain = True
            for el in arr.elements:
                if isinstance(el, int) and 0 <= el < N:
                    int_elems.append(el)
                else:
                    valid_domain = False
                    break

            if not valid_domain:
                continue

            idx_to_ptrs: Dict[int, List[str]] = {}
            for ptr_name, idx_val in (arr.active_indices or {}).items():
                if 0 <= idx_val < N:
                    idx_to_ptrs.setdefault(idx_val, []).append(ptr_name)

            proven_vars = self._get_syntactically_proven_indices(
                self._current_func, self._current_line, arr.name
            )
            for v_name in proven_vars:
                if v_name in leaf_scalar_ints:
                    v_val = leaf_scalar_ints[v_name]
                    if 0 <= v_val < N and v_name not in idx_to_ptrs.get(v_val, []):
                        idx_to_ptrs.setdefault(v_val, []).append(v_name)

            forest_nodes: List[GraphNode] = []
            forest_edges: List[GraphEdge] = []
            leaf_field_name = arr.name.split("->")[-1].split(".")[-1]

            for i, target_idx in enumerate(int_elems):
                node_id = f"idx-{i}"
                ptrs = idx_to_ptrs.get(i, [])
                is_root = target_idx == i
                forest_nodes.append(
                    GraphNode(
                        id=node_id,
                        type="IndexNode",
                        c_type=f"Index [{i}]",
                        label=f"[{i}] → {target_idx}",
                        fields={
                            "index": i,
                            leaf_field_name: target_idx,
                            "role": "root" if is_root else "child",
                        },
                        is_active=bool(ptrs),
                        is_freed=False,
                        pointers=ptrs,
                    )
                )
                if target_idx != i:
                    forest_edges.append(
                        GraphEdge(
                            source=node_id,
                            target=f"idx-{target_idx}",
                            label=leaf_field_name,
                            field_order_idx=0,
                        )
                    )

            return GraphSnapshot(nodes=forest_nodes, edges=forest_edges)

        return None

    # ==========================================================================
    # Pipelined DWARF Pointer-Mesh & Struct Buffer Crawler
    # ==========================================================================

    def _extract_struct_array_field(
        self,
        owner_name: str,
        field_name: str,
        array_base_addr: str,
        elem_struct_type: str,
        is_pointer_array: bool,
        sister_scalars: Dict[str, int],
        leaf_scalar_ints: Dict[str, int],
        all_scalar_ints: Dict[str, int],
    ) -> Optional[ArraySnapshot]:
        lookup_name = field_name if field_name else owner_name
        buf_len = self._infer_pointer_buffer_length(
            ptr_leaf_name=lookup_name,
            sister_scalars=sister_scalars,
            frame_scalars=all_scalar_ints,
        )
        if not buf_len or not (1 <= buf_len <= MAX_STRUCT_BUFFER_ELEMENTS):
            return None

        compound_elements: List[Dict[str, Any]] = []

        if is_pointer_array:
            ptr_slice_raw = self._eval_expr(f"*(void *[{buf_len}]*)({array_base_addr})")
            if not ptr_slice_raw:
                return None
            elem_addrs = parse_gdb_array(ptr_slice_raw, max_elems=buf_len)

            valid_elem_addrs: List[str] = []
            for raw_elem_ptr in elem_addrs:
                elem_addr = extract_hex_address(str(raw_elem_ptr))
                if (
                    elem_addr
                    and self._is_valid_heap_or_data_address(elem_addr)
                    and elem_addr not in self._freed_addresses
                ):
                    valid_elem_addrs.append(elem_addr)

            if valid_elem_addrs:
                deref_exprs = [
                    f"*(({elem_struct_type} *){e_addr})" for e_addr in valid_elem_addrs
                ]
                batch_derefs = self._eval_expr_batch(deref_exprs)
                for e_addr, d_expr in zip(valid_elem_addrs, deref_exprs):
                    elem_deref = batch_derefs.get(d_expr)
                    if elem_deref:
                        rec = self._serialize_compound_struct_element(elem_deref, addr=e_addr)
                        if rec:
                            compound_elements.append(rec)
        else:
            val_slice_raw = self._eval_expr(
                f"*({elem_struct_type}[{buf_len}]*)({array_base_addr})"
            )
            if not val_slice_raw:
                return None
            raw_structs = parse_gdb_array(val_slice_raw, max_elems=buf_len)
            for item_str in raw_structs:
                if isinstance(item_str, str) and item_str.startswith("{"):
                    rec = self._serialize_compound_struct_element(item_str)
                    if rec:
                        compound_elements.append(rec)

        if not compound_elements:
            return None

        active_idx = self._collect_struct_buffer_indices(
            owner_name=owner_name,
            field_name=lookup_name,
            sister_scalars=sister_scalars,
            frame_scalar_ints=leaf_scalar_ints,
            array_len=len(compound_elements),
        )

        short_type = elem_struct_type.replace("struct ", "").strip() + (
            "*" if is_pointer_array else ""
        )
        full_name = f"{owner_name}->{field_name}" if field_name else owner_name
        return ArraySnapshot(
            name=full_name,
            type=short_type,
            kind="array",
            element_type=elem_struct_type,
            is_compound=True,
            capacity=buf_len,
            elements=compound_elements,
            active_indices=active_idx,
        )

    def _crawl_pointer_graph(
        self,
        active_struct_ptrs: Dict[str, Tuple[str, str]],
        leaf_scalar_ints: Dict[str, int],
        all_scalar_ints: Dict[str, int],
    ) -> Tuple[GraphSnapshot, List[ArraySnapshot]]:
        seen_addresses: Set[str] = set()
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        embedded_arrays: List[ArraySnapshot] = []
        seen_edges: Set[Tuple[str, str, str]] = set()

        addr_to_ptr_names: Dict[str, List[str]] = {}
        frontier: List[Tuple[str, str, str]] = []

        # 1. Seed from active stack pointers across frames
        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if self._is_system_or_runtime_symbol(s_type, s_type):
                continue
            if self._is_valid_heap_or_data_address(addr):
                addr_to_ptr_names.setdefault(addr, []).append(ptr_name)
                if addr not in seen_addresses:
                    seen_addresses.add(addr)
                    frontier.append((addr, s_type, ptr_name.split(":")[-1]))

        # 2. Seed any known live heap structs so recursion base cases (`root == NULL`)
        #    never wipe the existing tree/list on the canvas!
        for live_addr, live_type in list(self._live_heap_structs.items()):
            if (
                live_addr not in seen_addresses
                and live_addr not in self._freed_addresses
                and self._is_valid_heap_or_data_address(live_addr)
            ):
                seen_addresses.add(live_addr)
                frontier.append((live_addr, live_type, "heap"))

        while frontier and len(nodes) < MAX_GRAPH_NODES:
            current_batch = frontier[: MAX_GRAPH_NODES - len(nodes)]
            frontier = frontier[MAX_GRAPH_NODES - len(nodes) :]

            batch_expr_map: Dict[str, str] = {
                addr: f"*(({struct_type} *){addr})"
                for addr, struct_type, _ in current_batch
            }
            batch_deref_results = self._eval_expr_batch(list(batch_expr_map.values()))

            next_frontier: List[Tuple[str, str, str]] = []

            for addr, struct_type, owner_name in current_batch:
                deref_str = batch_deref_results.get(batch_expr_map[addr])
                if not deref_str:
                    continue

                raw_fields = parse_gdb_struct_body(deref_str)
                if not raw_fields:
                    continue

                field_types = self._ensure_struct_field_types(struct_type)
                field_order_list = list(field_types.keys())
                is_freed = self._is_tcache_poisoned(addr, raw_fields)
                pointing_vars = addr_to_ptr_names.get(addr, [])

                if is_freed:
                    self._freed_struct_types[addr] = struct_type
                    last_known = self._last_valid_node_fields.get(addr, {})
                    freed_fields: Dict[str, Any] = (
                        dict(last_known) if last_known else {"status": "FREED"}
                    )
                    nodes.append(
                        GraphNode(
                            id=addr,
                            type=struct_type,
                            c_type=struct_type,
                            label="FREED",
                            fields=freed_fields,
                            is_active=bool(pointing_vars),
                            is_freed=True,
                            pointers=pointing_vars,
                        )
                    )
                    continue

                self._live_heap_structs[addr] = struct_type

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
                scalar_summary_parts: List[str] = []
                self_ref_fields_ordered: List[str] = []

                for f_name, f_val in raw_fields.items():
                    declared_f_type = field_types.get(f_name, "").strip()
                    f_order_idx = (
                        field_order_list.index(f_name)
                        if f_name in field_order_list
                        else 0
                    )

                    # Case 1: Inline fixed array member inside struct
                    if f_val.startswith("{") and f_val.endswith("}"):
                        sub_items = parse_gdb_array(
                            f_val, max_elems=MAX_STRUCT_BUFFER_ELEMENTS
                        )
                        arr_decl_match = FIXED_ARR_RE.match(declared_f_type)
                        elem_decl_type = (
                            arr_decl_match.group(1).strip()
                            if arr_decl_match
                            else declared_f_type.rstrip("*").strip()
                        )
                        elem_kind, elem_target = self._resolve_type_info(elem_decl_type)

                        if elem_kind == "struct_ptr" or "*" in elem_decl_type:
                            target_s_type = (
                                elem_target
                                if elem_kind == "struct_ptr"
                                else elem_decl_type.rstrip("*").strip() or struct_type
                            )
                            non_null_count = 0
                            for idx, item in enumerate(sub_items):
                                sub_addr = extract_hex_address(str(item))
                                if sub_addr and self._is_valid_heap_or_data_address(
                                    sub_addr
                                ):
                                    non_null_count += 1
                                    edge_label = f"{f_name}[{idx}]"
                                    edge_key = (addr, sub_addr, edge_label)
                                    if edge_key not in seen_edges:
                                        seen_edges.add(edge_key)
                                        edges.append(
                                            GraphEdge(
                                                source=addr,
                                                target=sub_addr,
                                                label=edge_label,
                                                field_order_idx=idx,
                                            )
                                        )
                                    if sub_addr not in seen_addresses:
                                        seen_addresses.add(sub_addr)
                                        next_frontier.append(
                                            (
                                                sub_addr,
                                                target_s_type,
                                                f"{owner_name}->{f_name}[{idx}]",
                                            )
                                        )
                            node_fields[f_name] = f"ptr[{len(sub_items)}] ({non_null_count} active)"
                        elif sub_items:
                            formatted_sub = [format_scalar_val(x) for x in sub_items]
                            node_fields[f_name] = formatted_sub
                            active_idx = self._collect_struct_buffer_indices(
                                owner_name=owner_name,
                                field_name=f_name,
                                sister_scalars=sister_scalars,
                                frame_scalar_ints=leaf_scalar_ints,
                                array_len=len(formatted_sub),
                            )
                            embedded_arrays.append(
                                ArraySnapshot(
                                    name=f"{owner_name}->{f_name}",
                                    type=elem_decl_type or "int",
                                    kind="array",
                                    element_type=elem_decl_type or "int",
                                    is_compound=False,
                                    capacity=len(formatted_sub),
                                    elements=formatted_sub,
                                    active_indices=active_idx,
                                )
                            )
                        continue

                    is_ptr_field, f_kind, f_target_type = self._is_field_pointer_type(
                        declared_f_type, f_name, f_val
                    )

                    # Case 2: Pointer or Pointer-Array member
                    if is_ptr_field:
                        if f_kind == "struct_ptr" and f_target_type == struct_type:
                            self_ref_fields_ordered.append(f_name)

                        target_addr = extract_hex_address(f_val)
                        if is_explicit_null(f_val, is_known_pointer=True) or not target_addr:
                            node_fields[f_name] = "NULL"
                            continue

                        node_fields[f_name] = target_addr
                        if not self._is_valid_heap_or_data_address(target_addr):
                            continue

                        # Subcase 2A: Dynamic Pointer-to-Pointer Array (`Type **adj` or `Type **array`)
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

                            if self._has_struct_pointer_links(elem_struct):
                                table_len = self._infer_pointer_buffer_length(
                                    ptr_leaf_name=f_name,
                                    sister_scalars=sister_scalars,
                                    frame_scalars=all_scalar_ints,
                                )
                                if table_len and 1 <= table_len <= MAX_STRUCT_BUFFER_ELEMENTS:
                                    ptr_table_raw = self._eval_expr(
                                        f"*(void *[{table_len}]*)({target_addr})"
                                    )
                                    if ptr_table_raw:
                                        head_ptrs = parse_gdb_array(
                                            ptr_table_raw, max_elems=table_len
                                        )
                                        for idx, raw_hp in enumerate(head_ptrs):
                                            hp_addr = extract_hex_address(str(raw_hp))
                                            if (
                                                hp_addr
                                                and self._is_valid_heap_or_data_address(hp_addr)
                                                and hp_addr not in self._freed_addresses
                                            ):
                                                edge_label = f"{f_name}[{idx}]"
                                                edge_key = (addr, hp_addr, edge_label)
                                                if edge_key not in seen_edges:
                                                    seen_edges.add(edge_key)
                                                    edges.append(
                                                        GraphEdge(
                                                            source=addr,
                                                            target=hp_addr,
                                                            label=edge_label,
                                                            field_order_idx=idx,
                                                        )
                                                    )
                                                if hp_addr not in seen_addresses:
                                                    seen_addresses.add(hp_addr)
                                                    next_frontier.append(
                                                        (
                                                            hp_addr,
                                                            elem_struct,
                                                            f"{owner_name}->{f_name}[{idx}]",
                                                        )
                                                    )
                            else:
                                comp_snap = self._extract_struct_array_field(
                                    owner_name=owner_name,
                                    field_name=f_name,
                                    array_base_addr=target_addr,
                                    elem_struct_type=elem_struct,
                                    is_pointer_array=True,
                                    sister_scalars=sister_scalars,
                                    leaf_scalar_ints=leaf_scalar_ints,
                                    all_scalar_ints=all_scalar_ints,
                                )
                                if comp_snap is not None:
                                    embedded_arrays.append(comp_snap)
                            continue

                        # Subcase 2B: Dynamic Primitive Buffer (`int *parent`, `int *data`)
                        if (
                            f_kind == "primitive_ptr"
                            and "**" not in declared_f_type
                            and target_addr not in self._freed_addresses
                        ):
                            elem_c_type = f_target_type
                            buf_len = self._infer_pointer_buffer_length(
                                ptr_leaf_name=f_name,
                                sister_scalars=sister_scalars,
                                frame_scalars=all_scalar_ints,
                            )
                            if buf_len and 1 <= buf_len <= MAX_STRUCT_BUFFER_ELEMENTS:
                                deref_buf_expr = (
                                    f"*({elem_c_type}[{buf_len}]*)({target_addr})"
                                )
                                buf_val_str = self._eval_expr(deref_buf_expr)
                                if buf_val_str:
                                    elements = [
                                        format_scalar_val(x)
                                        for x in parse_gdb_array(
                                            buf_val_str,
                                            max_elems=MAX_STRUCT_BUFFER_ELEMENTS,
                                        )
                                    ]
                                    if elements:
                                        active_idx = self._collect_struct_buffer_indices(
                                            owner_name=owner_name,
                                            field_name=f_name,
                                            sister_scalars=sister_scalars,
                                            frame_scalar_ints=leaf_scalar_ints,
                                            array_len=len(elements),
                                        )
                                        embedded_arrays.append(
                                            ArraySnapshot(
                                                name=f"{owner_name}->{f_name}",
                                                type=elem_c_type,
                                                kind="array",
                                                element_type=elem_c_type,
                                                is_compound=False,
                                                capacity=buf_len,
                                                elements=elements,
                                                active_indices=active_idx,
                                            )
                                        )
                            continue

                        # Subcase 2C: Single Struct Pointer (`struct Node *next`, `left`, `right`, `parent`)
                        target_s_type = (
                            f_target_type
                            if f_kind == "struct_ptr"
                            else (
                                declared_f_type.rstrip("*").strip()
                                if "*" in declared_f_type
                                else struct_type
                            )
                        )
                        if not target_s_type.startswith("struct "):
                            _, res_s = self._resolve_type_info(target_s_type)
                            target_s_type = res_s or f"struct {target_s_type}"

                        if not self._has_struct_pointer_links(target_s_type) and sister_scalars:
                            comp_snap = self._extract_struct_array_field(
                                owner_name=owner_name,
                                field_name=f_name,
                                array_base_addr=target_addr,
                                elem_struct_type=target_s_type,
                                is_pointer_array=False,
                                sister_scalars=sister_scalars,
                                leaf_scalar_ints=leaf_scalar_ints,
                                all_scalar_ints=all_scalar_ints,
                            )
                            if comp_snap is not None and len(comp_snap.elements) > 1:
                                embedded_arrays.append(comp_snap)
                                continue

                        if target_addr != addr:
                            edge_key = (addr, target_addr, f_name)
                            if edge_key not in seen_edges:
                                seen_edges.add(edge_key)
                                edges.append(
                                    GraphEdge(
                                        source=addr,
                                        target=target_addr,
                                        label=f_name,
                                        field_order_idx=f_order_idx,
                                    )
                                )
                        if target_addr not in seen_addresses:
                            seen_addresses.add(target_addr)
                            next_frontier.append(
                                (target_addr, target_s_type, f"{owner_name}->{f_name}")
                            )
                        continue

                    # Case 3: Scalar value field
                    parsed_scalar = format_scalar_val(parse_scalar(f_val))
                    node_fields[f_name] = parsed_scalar
                    scalar_summary_parts.append(f"{f_name}: {parsed_scalar}")

                node_label = (
                    " · ".join(scalar_summary_parts[:2])
                    if scalar_summary_parts
                    else struct_type.replace("struct ", "")
                )

                self._last_valid_node_fields[addr] = dict(node_fields)

                nodes.append(
                    GraphNode(
                        id=addr,
                        type=struct_type,
                        c_type=struct_type,
                        label=node_label,
                        fields=node_fields,
                        is_active=bool(pointing_vars),
                        is_freed=False,
                        pointers=pointing_vars,
                        self_ref_order=self_ref_fields_ordered,
                    )
                )

            frontier.extend(next_frontier)

        # 3. Also append any freed struct nodes that were orphaned when their pointer moved/freed
        emitted_ids = {n.id for n in nodes}
        for f_addr in self._freed_addresses:
            if f_addr not in emitted_ids and f_addr in self._last_valid_node_fields:
                if len(nodes) >= MAX_GRAPH_NODES:
                    break
                f_type = self._freed_struct_types.get(f_addr, "struct")
                pointing_vars = addr_to_ptr_names.get(f_addr, [])
                nodes.append(
                    GraphNode(
                        id=f_addr,
                        type=f_type,
                        c_type=f_type,
                        label="FREED",
                        fields=dict(self._last_valid_node_fields[f_addr]),
                        is_active=bool(pointing_vars),
                        is_freed=True,
                        pointers=pointing_vars,
                    )
                )

        return (
            GraphSnapshot(
                nodes=nodes,
                edges=edges,
            ),
            embedded_arrays,
        )

    @staticmethod
    def _is_valid_heap_or_data_address(addr: str) -> bool:
        try:
            val = int(addr, 16)
        except ValueError:
            return False
        if val < 0x402000:
            return False
        # Exclude shared library memory regions (`0x7f0000000000` - `0x7ffffff00000`)
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
