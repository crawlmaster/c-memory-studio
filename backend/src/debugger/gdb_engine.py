#!/usr/bin/env python3
"""
backend/src/debugger/gdb_engine.py

Purely Structural DWARF/GDB-MI Introspection Engine for C-Memory-Studio.
Zero hardcoded variable names, struct member names, or algorithm presets.

Core Capabilities:
  1. Multi-Frame Call Stack Harvesting: Inspects variables across all active user frames
     (from leaf function up to `main()`) so caller data structures never vanish during helper calls.
  2. Algorithmic Complexity Step Filter:
     - Straight-line O(1) helpers (no `for`/`while`/`do` loops and no recursion) execute atomically via `-exec-next`.
     - Iterative or recursive functions are stepped into via `-exec-step`.
  3. Pure DWARF Pointer-Mesh Crawler:
     - Every allocated struct is keyed by its canonical hex address (`0x...`).
     - All scalar members are serialized in exact DWARF declaration order (`ptype`).
     - Struct pointer fields (`T*`), inline pointer arrays (`children[26]`), and dynamic pointer tables
       (`adj[V]`, `buckets[M]`) emit directed edges (`source`, `target`, `label`) for all non-NULL slots.
  4. Generic Compound Struct-Array & Primitive Buffer Inspector:
     - Non-linked struct arrays (`Type[N]`, `Type*`, `Type**`) emit compound element records containing
       all scalar DWARF fields in declaration order without synthetic labels or fake indices.
  5. Syntactic Subscript & Induction Proof Engine:
     - Binds integer variables to `active_indices` strictly via syntactic subscript/induction proof in `target.c`.
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
# C Lexical & Grammar Constants (Standard C Language Tokens Only)
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

C_CONTROL_KEYWORDS = {"if", "for", "while", "switch", "return", "sizeof", "typeof"}
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
# Clean Pydantic Data Contract
# ==============================================================================

class ArraySnapshot(BaseModel):
    name: str
    type: str
    element_type: str = ""
    is_compound: bool = False
    capacity: Optional[int] = None
    elements: List[Any]
    active_indices: Dict[str, int]


class GraphNode(BaseModel):
    id: str
    type: str
    c_type: str = ""
    label: str
    fields: Dict[str, Any]
    is_active: bool
    is_freed: bool = False
    pointers: List[str] = Field(default_factory=list)


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str


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
    """Splits a comma-separated GDB string at brace depth 0."""
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
# Purely Structural DWARF/GDB-MI Session Controller (`GDBTracer`)
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
        if self.source_path.exists():
            raw_text = self.source_path.read_text(encoding="utf-8", errors="replace")
            self._source_lines.extend(raw_text.splitlines())
            self._full_clean_source = C_COMMENTS_AND_STRINGS_RE.sub(" ", raw_text)

        self._type_resolution_cache: Dict[str, Tuple[str, str]] = {}
        self._struct_field_types_cache: Dict[str, Dict[str, str]] = {}
        self._struct_has_links_cache: Dict[str, bool] = {}
        self._freed_addresses: Set[str] = set()
        self._last_valid_node_fields: Dict[str, Dict[str, Any]] = {}

        # Syntactic analysis caches
        self._syntactic_index_cache: Dict[Tuple[str, str], Set[str]] = {}
        self._func_body_cache: Dict[str, str] = {}
        self._func_complexity_cache: Dict[str, bool] = {}
        self._alloc_bound_expr_cache: Dict[str, List[str]] = {}

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

    # ==========================================================================
    # Algorithmic Complexity Step Filter (Replaces Hardcoded Function Names)
    # ==========================================================================

    def _extract_function_body_by_name(
        self, func_name: str, anchor_line: Optional[int] = None
    ) -> str:
        """
        Extracts the brace-balanced C function body `{ ... }` for `func_name`
        from `self._source_lines`, stripping comments and string literals.
        """
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
                    # Verify this is a definition (followed by `{` on this or next line)
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
        # Strip the function signature prior to the first `{` so self-call detection only checks the body
        first_brace = cleaned_body.find("{")
        inner_body = cleaned_body[first_brace:] if first_brace != -1 else cleaned_body
        self._func_body_cache[func_name] = inner_body
        return inner_body

    def _is_complex_user_function(self, func_name: str) -> bool:
        """
        Determines purely from the AST/token structure of `func_name` whether it should be
        stepped into (`-exec-step`) vs stepped over atomically (`-exec-next`):
          - Straight-line O(1) functions with NO loops (`for`, `while`, `do`) and NO recursive
            self-calls return `False` (stepped over with `-exec-next`).
          - Functions containing loops or recursion return `True` (stepped into with `-exec-step`).
        """
        if func_name in self._func_complexity_cache:
            return self._func_complexity_cache[func_name]

        body = self._extract_function_body_by_name(func_name)
        if not body:
            self._func_complexity_cache[func_name] = False
            return False

        # Check for iterative loops (`for`, `while`, `do`)
        has_loop = bool(C_LOOP_STATEMENT_RE.search(body))

        # Check for recursive self-call inside body
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

    # ==========================================================================
    # Syntactic Subscript, Loop Induction & Allocation Bound Proof Engine
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

    def _get_syntactically_proven_indices(
        self,
        func_name: str,
        anchor_line: int,
        array_name: str,
    ) -> Set[str]:
        """
        Returns the set of variable identifiers syntactically proven to act as indices
        for `array_name` inside `func_name`:
          1. Direct Subscript Access: `arr[expr]` or `s->data[expr]`
          2. Pointer Offset Dereference: `*(arr + expr)` or `*(expr + arr)`
          3. Loop Induction Header: `for (...; var < ...; ...var...)` when `arr` is accessed
          4. Transitive Index Dataflow: `middle = low + (high - low) / 2`, `low = middle + 1`
        """
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

        # Proof 1: Direct Subscript Access `arr[sub_expr]`
        subscript_pattern = re.compile(
            rf"(?:{escaped_full}|\b{escaped_leaf})\s*\[([^\]]+)\]"
        )
        for match in subscript_pattern.finditer(body):
            sub_expr = match.group(1)
            for ident in self._extract_identifiers_from_expr(sub_expr):
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
            if subscript_pattern.search(rhs_expr) or ptr_arith_pattern.search(rhs_expr):
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
        for match in subscript_pattern.finditer(body):
            direct_subscript_vars.update(
                self._extract_identifiers_from_expr(match.group(1))
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
        """
        Finds all struct member identifiers that appear inside `->field_name[...]` or `.field_name[...]`
        across the entire C program (e.g. `s->data[s->top]` proves `top` is a cursor for `data`).
        """
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
        """
        Infers the element count of a dynamically allocated pointer (`ptr_leaf_name`)
        purely from syntactic evidence and structural relationships (zero hardcoded names):
          1. Syntactic `malloc`/`calloc`/`realloc` inspection: extracts the count identifier
             from `ptr = malloc(COUNT * sizeof(...))` or `ptr = calloc(COUNT, sizeof(...))`.
          2. Loop upper bound inspection: `var < BOUND` where `var` indexes `ptr[var]`.
          3. Structural sister scalar fallback: for a struct-embedded buffer (`s->data`),
             picks any positive sister integer field that is NOT a subscript cursor for `ptr_leaf_name`
             (or if all sister fields are cursors, uses `cursor + 1`).
        """
        if ptr_leaf_name not in self._alloc_bound_expr_cache:
            candidates: List[str] = []
            esc = re.escape(ptr_leaf_name)
            # Match `ptr = (cast)malloc(EXPR * sizeof...)` or `calloc(EXPR, ...)`
            alloc_re = re.compile(
                rf"\b{esc}\s*=\s*(?:\([^\)]*\)\s*)?(?:malloc|calloc|realloc)\s*\(\s*([^,\)\*]+)"
            )
            for m in alloc_re.finditer(self._full_clean_source):
                for ident in self._extract_identifiers_from_expr(m.group(1)):
                    if ident not in candidates:
                        candidates.append(ident)

            # Also check `< BOUND` in loops that subscript `ptr_leaf_name`
            bound_re = re.compile(rf"<\s*([a-zA-Z_][a-zA-Z0-9_]*)\b")
            for m in bound_re.finditer(self._full_clean_source):
                ident = m.group(1)
                if ident not in C_SYNTAX_KEYWORDS and ident not in candidates:
                    candidates.append(ident)

            self._alloc_bound_expr_cache[ptr_leaf_name] = candidates

        bound_candidates = self._alloc_bound_expr_cache[ptr_leaf_name]
        proven_cursors = self._get_global_field_subscript_cursors(ptr_leaf_name)

        # 1. Check sister scalars in the same struct that match syntactic bound expressions
        for cand in bound_candidates:
            if cand in sister_scalars and cand not in proven_cursors:
                val = sister_scalars[cand]
                if 1 <= val <= 4096:
                    return min(val, MAX_STRUCT_BUFFER_ELEMENTS)

        # 2. Check non-cursor sister scalars in the same struct (e.g. `capacity` or `size` or `V`)
        non_cursor_sisters = [
            val
            for k, val in sister_scalars.items()
            if k not in proven_cursors and 1 <= val <= 4096
        ]
        if non_cursor_sisters:
            # Prefer the smallest positive bound (active size) if multiple non-cursor bounds exist,
            # or the sole positive bound (capacity).
            return min(min(non_cursor_sisters), MAX_STRUCT_BUFFER_ELEMENTS)

        # 3. Check frame scalars matching syntactic allocation/loop bounds
        local_proven_cursors = self._get_syntactically_proven_indices(
            self._current_func, self._current_line, ptr_leaf_name
        )
        for cand in bound_candidates:
            if cand in frame_scalars and cand not in local_proven_cursors:
                val = frame_scalars[cand]
                if 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val

        # 4. Fallback to any non-cursor positive integer in frame scope (if top-level pointer)
        if not sister_scalars:
            for k, val in frame_scalars.items():
                if k not in local_proven_cursors and 1 <= val <= MAX_ARRAY_ELEMENTS:
                    return val

        # 5. Last resort for struct buffers: if only a cursor sister field is >= 0, read up to `cursor + 1`
        for k, val in sister_scalars.items():
            if k in proven_cursors and 0 <= val < MAX_STRUCT_BUFFER_ELEMENTS:
                return val + 1

        return None

    # ==========================================================================
    # DWARF Type & Struct Topology Classification
    # ==========================================================================

    def _resolve_type_info(self, raw_type: str) -> Tuple[str, str]:
        """
        Resolves any C type via DWARF `ptype` into `(category, target_c_type)`:
          - `("struct_ptr_array", "struct Node")` -> for `Node **` or `struct Node **`
          - `("primitive_ptr_array", "int")`      -> for `int **`
          - `("struct_ptr", "struct stack_t")`    -> for `struct Node *` or pointer-typedef
          - `("struct_val", "struct stack_t")`    -> for `struct Node` by value
          - `("primitive_ptr", "int")`            -> for `int *`, `double *`
          - `("primitive", "int")`                -> for `int`, `size_t`, etc.
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

    def _has_struct_pointer_links(self, struct_type: str) -> bool:
        """
        Pure DWARF structural check: returns True if `struct_type` contains at least one
        pointer or pointer-array member targeting a struct (e.g. linked list node, tree node,
        trie node with `children[26]`, or graph container).
        Returns False if `struct_type` consists purely of scalar primitives (e.g. a tuple
        `{int v; int dist;}` or `{int u; int v; int w;}`).
        """
        if struct_type in self._struct_has_links_cache:
            return self._struct_has_links_cache[struct_type]

        f_types = self._ensure_struct_field_types(struct_type)
        has_links = False
        for f_decl in f_types.values():
            arr_m = FIXED_ARR_RE.match(f_decl)
            check_t = arr_m.group(1).strip() if arr_m else f_decl
            kind, _ = self._resolve_type_info(check_t)
            if kind in {"struct_ptr", "struct_ptr_array"}:
                has_links = True
                break

        self._struct_has_links_cache[struct_type] = has_links
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

    def _collect_all_frame_variables(self) -> Tuple[List[str], List[Dict[str, Any]]]:
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

    def _serialize_compound_struct_element(
        self, raw_struct_str: str, addr: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Serializes a non-linked struct instance into a generic compound element record
        containing all scalar DWARF fields in declaration order (`fields`), plus
        generic `label`, `value`, and `secondary` keys derived strictly from declaration order.
        """
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
        ):
            return None

        call_stack, raw_vars = self._collect_all_frame_variables()

        locals_out: Dict[str, Any] = {}
        scalar_ints: Dict[str, int] = {}
        leaf_scalar_ints: Dict[str, int] = {}
        active_struct_ptrs: Dict[str, Tuple[str, str]] = {}
        raw_array_vars: List[Tuple[str, str, int, int]] = []
        raw_ptr_vars: List[Tuple[str, str, str, int]] = []

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

            arr_match = FIXED_ARR_RE.match(v_type)
            if arr_match and not FIXED_2D_ARR_RE.match(v_type):
                elem_type = arr_match.group(1).strip()
                arr_len = min(int(arr_match.group(2)), MAX_ARRAY_ELEMENTS)
                raw_array_vars.append((v_name, elem_type, arr_len, f_level))
                continue

            type_kind, resolved_target = self._resolve_type_info(v_type)

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
                        or "realloc" in line_txt
                        or "=" in line_txt
                    ):
                        self._freed_addresses.discard(addr)

                active_struct_ptrs[v_name] = (addr, resolved_target)
                continue

            if type_kind == "primitive_ptr":
                addr = extract_hex_address(v_val)
                if f_level == 0:
                    locals_out[v_name] = addr if addr else "0x0"
                if addr:
                    raw_ptr_vars.append((v_name, resolved_target, addr, f_level))
                continue

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

            parsed_val = parse_scalar(v_val)
            if isinstance(parsed_val, int):
                scalar_ints[v_name] = parsed_val
                if f_level == 0:
                    leaf_scalar_ints[v_name] = parsed_val
                    locals_out[v_name] = format_scalar_val(parsed_val)
            elif f_level == 0:
                locals_out[v_name] = parsed_val

        # ----------------------------------------------------------------------
        # Pass 2: Top-Level 1D Arrays (Primitive Arrays & Compound Struct Arrays)
        # ----------------------------------------------------------------------
        arrays_snapshot: List[ArraySnapshot] = []

        for arr_name, elem_type, arr_len, f_level in raw_array_vars:
            if f_level != 0:
                self._cmd(f"-stack-select-frame {f_level}")
            expr_val = self._eval_expr(arr_name)
            if f_level != 0:
                self._cmd("-stack-select-frame 0")

            if not expr_val:
                continue

            elem_kind, elem_resolved = self._resolve_type_info(elem_type)
            raw_items = parse_gdb_array(expr_val, max_elems=arr_len)

            if elem_kind == "struct_val" and not self._has_struct_pointer_links(elem_resolved):
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
                            element_type=elem_resolved,
                            is_compound=True,
                            capacity=arr_len,
                            elements=compound_elems,
                            active_indices=active_idx,
                        )
                    )
            else:
                elements = [format_scalar_val(x) for x in raw_items]
                active_idx = self._collect_active_indices(
                    leaf_scalar_ints, len(elements), array_name=arr_name
                )
                arrays_snapshot.append(
                    ArraySnapshot(
                        name=arr_name,
                        type=elem_type,
                        element_type=elem_type,
                        is_compound=False,
                        capacity=arr_len,
                        elements=elements,
                        active_indices=active_idx,
                    )
                )

        for ptr_name, elem_type, addr, _ in raw_ptr_vars:
            if (
                addr in self._freed_addresses
                or not self._is_valid_heap_or_data_address(addr)
            ):
                continue

            inferred_len = self._infer_pointer_buffer_length(
                ptr_leaf_name=ptr_name,
                sister_scalars={},
                frame_scalars=scalar_ints,
            )
            if inferred_len and 1 <= inferred_len <= MAX_ARRAY_ELEMENTS:
                deref_expr = f"*({elem_type}[{inferred_len}]*)({addr})"
                expr_val = self._eval_expr(deref_expr)
                if expr_val:
                    raw_elements = parse_gdb_array(expr_val, max_elems=inferred_len)
                    if raw_elements:
                        formatted_elements = [
                            format_scalar_val(x) for x in raw_elements
                        ]
                        active_idx = self._collect_active_indices(
                            leaf_scalar_ints,
                            len(formatted_elements),
                            array_name=ptr_name,
                        )
                        arrays_snapshot.append(
                            ArraySnapshot(
                                name=ptr_name,
                                type=elem_type,
                                element_type=elem_type,
                                is_compound=False,
                                capacity=inferred_len,
                                elements=formatted_elements,
                                active_indices=active_idx,
                            )
                        )

        # ----------------------------------------------------------------------
        # Pass 3: Pure DWARF Pointer-Mesh Crawler & Embedded Struct Buffers
        # ----------------------------------------------------------------------
        graph_snapshot, embedded_arrays = self._crawl_pointer_graph(
            active_struct_ptrs, leaf_scalar_ints, scalar_ints
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
    # Pure DWARF Pointer-Mesh & Struct Buffer Crawler
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
        """
        Extracts a dynamic array of non-linked structs (`Type *arr` or `Type **arr`)
        as a generic compound tuple array without synthetic titles or fake indices.
        """
        buf_len = self._infer_pointer_buffer_length(
            ptr_leaf_name=field_name,
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
            for raw_elem_ptr in elem_addrs:
                elem_addr = extract_hex_address(str(raw_elem_ptr))
                if (
                    not elem_addr
                    or not self._is_valid_heap_or_data_address(elem_addr)
                    or elem_addr in self._freed_addresses
                ):
                    continue
                elem_deref = self._eval_expr(f"*(({elem_struct_type} *){elem_addr})")
                if not elem_deref:
                    continue
                rec = self._serialize_compound_struct_element(elem_deref, addr=elem_addr)
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
            field_name=field_name,
            sister_scalars=sister_scalars,
            frame_scalar_ints=leaf_scalar_ints,
            array_len=len(compound_elements),
        )

        short_type = elem_struct_type.replace("struct ", "").strip() + (
            "*" if is_pointer_array else ""
        )
        return ArraySnapshot(
            name=f"{owner_name}->{field_name}",
            type=short_type,
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
        """
        Pure DWARF BFS Pointer-Mesh Crawler:
          - Crawls all reachable structs starting from stack frame struct pointers.
          - Serializes all scalar fields in exact DWARF declaration order (`ptype`).
          - Follows single struct pointers (`T*`), inline fixed pointer arrays (`children[26]`),
            and dynamic pointer tables (`T**` where `T` is a linked struct, e.g. `adj[V]`),
            emitting directed edges (`source`, `target`, `label`) for all non-NULL slots.
        """
        visited_addrs: Set[str] = set()
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        embedded_arrays: List[ArraySnapshot] = []
        seen_edges: Set[Tuple[str, str, str]] = set()

        addr_to_ptr_names: Dict[str, List[str]] = {}
        valid_seeds: List[Tuple[str, str, str]] = []

        for ptr_name, (addr, s_type) in active_struct_ptrs.items():
            if self._is_valid_heap_or_data_address(addr):
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

            # Pre-pass: collect all sister integer scalars in this struct
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

            for f_name, f_val in raw_fields.items():
                declared_f_type = field_types.get(f_name, "").strip()

                # Case 1: Inline fixed array member inside struct (e.g. `struct TrieNode *children[26]` or `int data[16]`)
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

                        # Pure DWARF distinction:
                        # - If `elem_struct` has struct pointer links (e.g. `AdjListNode` with `next`),
                        #   follow non-NULL entries `field[0 .. N-1]` as edges in the pointer mesh!
                        # - If `elem_struct` has NO struct pointer links (e.g. `MinHeapNode {v, dist}`),
                        #   emit it as a compound tuple array in `embedded_arrays`!
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
                                                    )
                                                )
                                            if hp_addr not in visited_addrs:
                                                queue.append(
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

                    # Subcase 2B: Dynamic Primitive Buffer (`int *data`, `int *pos`, `double *arr`)
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
                                            element_type=elem_c_type,
                                            is_compound=False,
                                            capacity=buf_len,
                                            elements=elements,
                                            active_indices=active_idx,
                                        )
                                    )
                        continue

                    # Subcase 2C: Single Struct Pointer (`struct Node *next`, `left`, `right`, or `Edge *edge`)
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

                    # If `target_s_type` has NO pointer links and `sister_scalars` has a size bound > 1,
                    # check if this pointer was allocated as a contiguous array of structs (e.g. `Edge *edge`)
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

                    edge_key = (addr, target_addr, f_name)
                    if edge_key not in seen_edges:
                        seen_edges.add(edge_key)
                        edges.append(
                            GraphEdge(
                                source=addr,
                                target=target_addr,
                                label=f_name,
                            )
                        )
                    if target_addr not in visited_addrs:
                        queue.append(
                            (target_addr, target_s_type, f"{owner_name}->{f_name}")
                        )
                    continue

                # Case 3: Scalar value field (preserved in exact DWARF declaration order)
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
                )
            )

        return (
            GraphSnapshot(
                nodes=nodes,
                edges=edges,
            ),
            embedded_arrays,
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
                    r"^(.+?[\s\*]+)([a-zA-Z_][a-zA-Z0-9_]*)(\[\d+\])?$", line
                )
                if m:
                    f_type = m.group(1).strip()
                    f_name = m.group(2).strip()
                    arr_suffix = m.group(3) or ""
                    field_map[f_name] = f"{f_type}{arr_suffix}"

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
