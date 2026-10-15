#!/usr/bin/env python3
"""
backend/src/analyzer/valgrind.py

Automated Valgrind Memcheck Auditor for C-Memory-Studio.
Compiles C code with `-g3 -O0 -no-pie -fno-builtin`, executes Valgrind with XML v4 output,
and extracts heap summaries, leak records, and invalid memory accesses.
"""

import os
import re
import signal
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

# ==============================================================================
# Constants & Configuration
# ==============================================================================

WORKSPACE_DIR = Path(os.getenv("TMPFS_PATH", "/sandbox/workspace"))
SOURCE_FILENAME = "valgrind_target.c"
BINARY_FILENAME = "valgrind_target"
XML_FILENAME = "valgrind.xml"

EXECUTION_TIMEOUT_SEC = 5

# Mapping from Valgrind XML <kind> to C-Memory-Studio state contract
VALGRIND_KIND_MAP: Dict[str, str] = {
    "Leak_DefinitelyLost": "DEFINITELY_LOST",
    "Leak_IndirectlyLost": "INDIRECTLY_LOST",
    "Leak_PossiblyLost": "POSSIBLY_LOST",
    "Leak_StillReachable": "STILL_REACHABLE",
    "InvalidRead": "INVALID_ACCESS",
    "InvalidWrite": "INVALID_ACCESS",
    "InvalidJump": "INVALID_ACCESS",
    "UninitCondition": "UNINITIALIZED_READ",
    "UninitValue": "UNINITIALIZED_READ",
    "InvalidFree": "INVALID_FREE",
    "MismatchedFree": "INVALID_FREE",
    "Overlap": "INVALID_ACCESS",
    "SyscallParam": "INVALID_ACCESS",
}

FATAL_ERROR_STATES = {"INVALID_ACCESS", "INVALID_FREE", "UNINITIALIZED_READ"}

# Regex patterns to extract hex addresses, byte sizes, and stderr heap totals
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
WHAT_SIZE_RE = re.compile(r"size\s+(\d+)", re.IGNORECASE)
AUXWHAT_BLOCK_SIZE_RE = re.compile(r"block of size\s+([\d,]+)", re.IGNORECASE)
HEAP_USAGE_RE = re.compile(
    r"total heap usage:\s*([\d,]+)\s+allocs,\s*([\d,]+)\s+frees,\s*([\d,]+)\s+bytes allocated",
    re.IGNORECASE,
)


# ==============================================================================
# Pydantic Output Models
# ==============================================================================

class SourceLocation(BaseModel):
    file: str = Field(default="valgrind_target.c")
    function: str = Field(default="unknown")
    line: int = Field(default=0)


class MemoryBlockReport(BaseModel):
    id: str
    address: str
    size_bytes: int
    block_count: int = Field(default=1)
    state: str
    allocated_at: Optional[SourceLocation] = None
    detected_at: Optional[SourceLocation] = None
    description: str


class AuditSummary(BaseModel):
    total_allocated_bytes: int
    total_freed_bytes: int
    leaked_bytes: int
    leak_count: int
    has_fatal_errors: bool
    exit_code: int = 0
    signal: Optional[str] = None


class ValgrindAuditResponse(BaseModel):
    success: bool
    compilation_error: Optional[str] = None
    runtime_error: Optional[str] = None
    summary: Optional[AuditSummary] = None
    blocks: List[MemoryBlockReport] = Field(default_factory=list)


# ==============================================================================
# Compilation & Execution Pipeline
# ==============================================================================

def compile_valgrind_target(
    source_code: str,
    workspace: Path = WORKSPACE_DIR,
) -> Tuple[bool, Path, Path, str]:
    """
    Saves incoming C code to `/sandbox/workspace/valgrind_target.c` and compiles with:
    `gcc -g3 -O0 -no-pie -fno-builtin -o /sandbox/workspace/valgrind_target /sandbox/workspace/valgrind_target.c`
    """
    workspace.mkdir(parents=True, exist_ok=True)
    source_path = workspace / SOURCE_FILENAME
    binary_path = workspace / BINARY_FILENAME

    # Remove stale artifacts from previous runs
    if binary_path.exists():
        binary_path.unlink()

    source_path.write_text(source_code, encoding="utf-8")

    compile_cmd = [
        "gcc",
        "-g3",
        "-O0",
        "-no-pie",
        "-fno-builtin",
        "-Wall",
        "-o",
        str(binary_path),
        str(source_path),
    ]

    proc = subprocess.run(
        compile_cmd,
        capture_output=True,
        text=True,
        timeout=EXECUTION_TIMEOUT_SEC,
    )

    if proc.returncode != 0:
        return (False, binary_path, source_path, proc.stderr.strip())

    return (True, binary_path, source_path, "")


def execute_valgrind(
    binary_path: Path,
    xml_path: Path,
    stdin_data: str = "",
) -> Tuple[int, str, str, bool]:
    """
    Executes Valgrind Memcheck on `binary_path` and writes XML v4 report to `xml_path`.
    Returns: (exit_code, stdout, stderr, timed_out)
    """
    if xml_path.exists():
        xml_path.unlink()

    valgrind_cmd = [
        "valgrind",
        "--tool=memcheck",
        "--leak-check=full",
        "--show-leak-kinds=all",
        "--track-origins=yes",
        "--xml=yes",
        f"--xml-file={xml_path}",
        str(binary_path),
    ]

    try:
        proc = subprocess.run(
            valgrind_cmd,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=EXECUTION_TIMEOUT_SEC,
        )
        return (proc.returncode, proc.stdout, proc.stderr, False)
    except subprocess.TimeoutExpired as exc:
        stderr_partial = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        stdout_partial = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        return (-1, stdout_partial, stderr_partial, True)


# ==============================================================================
# XML Parsing & Stack Frame Extraction
# ==============================================================================

def _extract_user_frame(stack_elem: Optional[ET.Element], target_file: str = SOURCE_FILENAME) -> Tuple[SourceLocation, str]:
    """
    Scans `<stack>/<frame>` entries from top to bottom.
    Finds the innermost frame matching `valgrind_target.c` (allocation or detection site),
    and extracts the instruction pointer `<ip>` or fallback function/line.
    """
    if stack_elem is None:
        return (SourceLocation(), "0x0")

    frames = stack_elem.findall("frame")
    first_ip = "0x0"

    for idx, frame in enumerate(frames):
        ip_text = (frame.findtext("ip") or "0x0").strip().lower()
        if idx == 0:
            first_ip = ip_text

        fn_text = (frame.findtext("fn") or "unknown").strip()
        file_text = (frame.findtext("file") or "").strip()
        line_text = (frame.findtext("line") or "0").strip()

        if Path(file_text).name == target_file:
            try:
                line_num = int(line_text)
            except ValueError:
                line_num = 0
            return (
                SourceLocation(
                    file=target_file,
                    function=fn_text,
                    line=line_num,
                ),
                first_ip,
            )

    # Fallback if user compiled without matching file symbols or error happened in main
    if frames:
        top = frames[0]
        fn_text = (top.findtext("fn") or "unknown").strip()
        file_text = Path(top.findtext("file") or target_file).name
        try:
            line_num = int(top.findtext("line") or 0)
        except ValueError:
            line_num = 0
        return (SourceLocation(file=file_text, function=fn_text, line=line_num), first_ip)

    return (SourceLocation(), first_ip)


def _extract_bytes_and_blocks(error_elem: ET.Element, what_text: str, auxwhat_texts: List[str]) -> Tuple[int, int]:
    """
    Extracts `(size_bytes, block_count)` from `<xwhat>` (for leaks) or `<what>`/`<auxwhat>`
    (for InvalidRead/InvalidWrite/InvalidFree).
    Supports both Valgrind XML v4 standard tags (`<leakedbytes>`, `<leakedblocks>`)
    and generic (`<bytes>`, `<blocks>`) tags.
    """
    xwhat = error_elem.find("xwhat")
    if xwhat is not None:
        bytes_str = (
            xwhat.findtext("leakedbytes")
            or xwhat.findtext("bytes")
            or "0"
        ).strip()
        blocks_str = (
            xwhat.findtext("leakedblocks")
            or xwhat.findtext("blocks")
            or "1"
        ).strip()
        try:
            b_val = int(bytes_str.replace(",", ""))
        except ValueError:
            b_val = 0
        try:
            blk_val = int(blocks_str.replace(",", ""))
        except ValueError:
            blk_val = 1
        return (b_val, blk_val)

    # If not a leak (e.g., InvalidRead/InvalidWrite), inspect `<auxwhat>` for allocated block size
    # e.g. "Address 0x4a5b044 is 0 bytes after a block of size 64 alloc'd"
    for aux in auxwhat_texts:
        m_blk = AUXWHAT_BLOCK_SIZE_RE.search(aux)
        if m_blk:
            return (int(m_blk.group(1).replace(",", "")), 1)

    # Or extract access size from `<what>`: "Invalid write of size 4"
    m_what = WHAT_SIZE_RE.search(what_text)
    if m_what:
        return (int(m_what.group(1)), 1)

    return (0, 1)


def _extract_target_address(auxwhat_texts: List[str], fallback_ip: str) -> str:
    """
    Extracts the heap memory address involved in the error from `<auxwhat>`
    (e.g., 'Address 0x5555555592a0 is 0 bytes inside a block...'),
    or falls back to the stack frame instruction pointer if Valgrind didn't emit a heap address.
    """
    for aux in auxwhat_texts:
        match = HEX_ADDR_RE.search(aux)
        if match:
            return match.group(1).lower()
    return fallback_ip


def _sanitize_or_recover_xml(xml_path: Path) -> Optional[ET.Element]:
    """
    Parses `/sandbox/workspace/valgrind.xml`. If the inferior process was killed by SIGKILL
    (timeout) or crashed mid-stream leaving `</valgrindoutput>` unclosed, repairs the XML tail.
    """
    if not xml_path.exists():
        return None

    raw_xml = xml_path.read_text(encoding="utf-8", errors="replace").strip()
    if not raw_xml:
        return None

    try:
        return ET.fromstring(raw_xml)
    except ET.ParseError:
        # Attempt recovery if `</valgrindoutput>` was truncated on timeout/crash
        if "<valgrindoutput>" in raw_xml and not raw_xml.endswith("</valgrindoutput>"):
            # Strip any half-written trailing tag and close root
            last_close = raw_xml.rfind("</error>")
            if last_close != -1:
                repaired = raw_xml[: last_close + len("</error>")] + "\n</valgrindoutput>"
            else:
                repaired = raw_xml + "\n</valgrindoutput>"
            try:
                return ET.fromstring(repaired)
            except ET.ParseError:
                return None
        return None


def parse_valgrind_report(
    xml_path: Path,
    stderr_text: str,
    exit_code: int,
) -> Tuple[AuditSummary, List[MemoryBlockReport]]:
    """
    Parses the Valgrind XML v4 file and stderr heap summary into structured
    `AuditSummary` and `List[MemoryBlockReport]`.
    """
    root = _sanitize_or_recover_xml(xml_path)
    blocks: List[MemoryBlockReport] = []

    leaked_bytes_total = 0
    leak_count = 0
    has_fatal_errors = False
    alloc_counter = 0

    if root is not None:
        for error_elem in root.findall("error"):
            raw_kind = (error_elem.findtext("kind") or "").strip()
            if not raw_kind:
                continue

            # Map Valgrind kind to our standardized state
            if raw_kind in VALGRIND_KIND_MAP:
                mapped_state = VALGRIND_KIND_MAP[raw_kind]
            elif raw_kind.startswith("Leak_"):
                mapped_state = raw_kind.replace("Leak_", "").upper()
            else:
                mapped_state = "INVALID_ACCESS"

            # Extract human-readable description from <xwhat><text> or <what>
            xwhat_elem = error_elem.find("xwhat")
            if xwhat_elem is not None and xwhat_elem.findtext("text"):
                description = xwhat_elem.findtext("text", "").strip()
            else:
                description = (error_elem.findtext("what") or raw_kind).strip()

            # Normalize multi-line Valgrind descriptions
            description = re.sub(r"\s+", " ", description)

            auxwhat_texts = [
                (aux.text or "").strip()
                for aux in error_elem.findall("auxwhat")
                if aux.text
            ]

            size_bytes, blk_count = _extract_bytes_and_blocks(
                error_elem, description, auxwhat_texts
            )

            stacks = error_elem.findall("stack")
            allocated_at: Optional[SourceLocation] = None
            detected_at: Optional[SourceLocation] = None
            fallback_ip = "0x0"

            is_leak = raw_kind.startswith("Leak_")

            if is_leak:
                # For Leak_* errors, stacks[0] is the allocation site (where malloc/calloc was called)
                if stacks:
                    allocated_at, fallback_ip = _extract_user_frame(stacks[0])
                if mapped_state in {"DEFINITELY_LOST", "INDIRECTLY_LOST", "POSSIBLY_LOST"}:
                    leaked_bytes_total += size_bytes
                    leak_count += blk_count
            else:
                # For InvalidRead / InvalidWrite / InvalidFree:
                # stacks[0] is the detection site (where invalid access/free occurred)
                # stacks[1] (if present) is the allocation site of the target heap block
                has_fatal_errors = True
                if len(stacks) >= 1:
                    detected_at, fallback_ip = _extract_user_frame(stacks[0])
                if len(stacks) >= 2:
                    allocated_at, _ = _extract_user_frame(stacks[1])
                else:
                    # Populate allocated_at with detected_at so callers expecting allocated_at never NullRef
                    allocated_at = detected_at

            address = _extract_target_address(auxwhat_texts, fallback_ip)
            alloc_counter += 1

            blocks.append(
                MemoryBlockReport(
                    id=f"alloc-{alloc_counter}",
                    address=address,
                    size_bytes=size_bytes,
                    block_count=blk_count,
                    state=mapped_state,
                    allocated_at=allocated_at,
                    detected_at=detected_at,
                    description=description,
                )
            )

        # Also check if Valgrind caught a fatal signal (<fatal_signal> tag in XML v4)
        fatal_sig_elem = root.find("fatal_signal")
        if fatal_sig_elem is not None:
            has_fatal_errors = True
            sig_name = (fatal_sig_elem.findtext("signame") or "SIGSEGV").strip()
            sig_stack = fatal_sig_elem.find("stack")
            det_loc, sig_ip = _extract_user_frame(sig_stack)
            alloc_counter += 1
            blocks.append(
                MemoryBlockReport(
                    id=f"alloc-{alloc_counter}",
                    address=sig_ip,
                    size_bytes=0,
                    block_count=1,
                    state="INVALID_ACCESS",
                    allocated_at=det_loc,
                    detected_at=det_loc,
                    description=f"Process terminated with fatal signal {sig_name}",
                )
            )

    # Detect fatal signal from exit code if not already flagged
    signal_name: Optional[str] = None
    if exit_code < 0:
        has_fatal_errors = True
        sig_num = -exit_code
        try:
            signal_name = signal.Signals(sig_num).name
        except ValueError:
            signal_name = f"SIG({sig_num})"
    elif exit_code in {134, 139}:
        # 128 + 6 (SIGABRT = 134), 128 + 11 (SIGSEGV = 139)
        has_fatal_errors = True
        signal_name = "SIGABRT" if exit_code == 134 else "SIGSEGV"

    # Extract lifetime heap totals from Valgrind stderr if available,
    # otherwise compute lower bound from XML blocks.
    total_allocated_bytes = sum(
        b.size_bytes for b in blocks if b.state in {
            "DEFINITELY_LOST", "INDIRECTLY_LOST", "POSSIBLY_LOST", "STILL_REACHABLE"
        }
    )
    m_heap = HEAP_USAGE_RE.search(stderr_text)
    if m_heap:
        try:
            parsed_total = int(m_heap.group(3).replace(",", ""))
            total_allocated_bytes = max(total_allocated_bytes, parsed_total)
        except ValueError:
            pass

    # Still-reachable + leaked bytes remain unfreed at exit; freed = total_allocated - unfreed
    unfreed_bytes = sum(
        b.size_bytes for b in blocks if b.state in {
            "DEFINITELY_LOST", "INDIRECTLY_LOST", "POSSIBLY_LOST", "STILL_REACHABLE"
        }
    )
    total_freed_bytes = max(0, total_allocated_bytes - unfreed_bytes)

    summary = AuditSummary(
        total_allocated_bytes=total_allocated_bytes,
        total_freed_bytes=total_freed_bytes,
        leaked_bytes=leaked_bytes_total,
        leak_count=leak_count,
        has_fatal_errors=has_fatal_errors,
        exit_code=exit_code,
        signal=signal_name,
    )

    return (summary, blocks)


# ==============================================================================
# High-Level Entrypoint Function
# ==============================================================================

def run_memory_audit(source_code: str, stdin_data: str = "") -> ValgrindAuditResponse:
    """
    Full synchronous pipeline:
    1. Compiles `source_code` to `/sandbox/workspace/valgrind_target`
    2. Runs Valgrind Memcheck with XML v4 output to `/sandbox/workspace/valgrind.xml`
    3. Parses XML + stderr summary and returns `ValgrindAuditResponse`.
    """
    compiled_ok, binary_path, _, gcc_stderr = compile_valgrind_target(source_code)
    if not compiled_ok:
        return ValgrindAuditResponse(
            success=False,
            compilation_error=gcc_stderr,
        )

    xml_path = WORKSPACE_DIR / XML_FILENAME
    exit_code, _, valgrind_stderr, timed_out = execute_valgrind(
        binary_path=binary_path,
        xml_path=xml_path,
        stdin_data=stdin_data,
    )

    summary, blocks = parse_valgrind_report(
        xml_path=xml_path,
        stderr_text=valgrind_stderr,
        exit_code=exit_code,
    )

    if timed_out:
        summary.has_fatal_errors = True
        return ValgrindAuditResponse(
            success=True,
            runtime_error=f"Execution timed out after {EXECUTION_TIMEOUT_SEC} seconds.",
            summary=summary,
            blocks=blocks,
        )

    return ValgrindAuditResponse(
        success=True,
        summary=summary,
        blocks=blocks,
    )
