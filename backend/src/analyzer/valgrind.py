#!/usr/bin/env python3
r"""
backend/src/analyzer/valgrind.py

Valgrind Memcheck & Heap Leak Audit Engine for C-Memory-Studio.
Compiles user C code with full DWARF-3 symbols in an isolated workspace,
executes Valgrind Memcheck (both XML protocol 4 and human-readable log summary),
and returns a comprehensive JSON audit payload.
"""

import concurrent.futures
import os
import re
import shutil
import subprocess
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

TMPFS_ROOT = Path(os.getenv("TMPFS_PATH", "/sandbox/workspace"))
COMPILE_TIMEOUT_SEC = 5.0
VALGRIND_TIMEOUT_SEC = 8.0

# Regex parsers for Valgrind's human-readable HEAP SUMMARY and LEAK SUMMARY blocks
IN_USE_AT_EXIT_RE = re.compile(
    r"in use at exit:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
    re.IGNORECASE,
)
TOTAL_HEAP_USAGE_RE = re.compile(
    r"total heap usage:\s*([\d,]+)\s*allocs,\s*([\d,]+)\s*frees,\s*([\d,]+)\s*bytes allocated",
    re.IGNORECASE,
)
LEAK_CATEGORY_RE = {
    "definitely_lost": re.compile(
        r"definitely lost:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
        re.IGNORECASE,
    ),
    "indirectly_lost": re.compile(
        r"indirectly lost:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
        re.IGNORECASE,
    ),
    "possibly_lost": re.compile(
        r"possibly lost:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
        re.IGNORECASE,
    ),
    "still_reachable": re.compile(
        r"still reachable:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
        re.IGNORECASE,
    ),
    "suppressed": re.compile(
        r"suppressed:\s*([\d,]+)\s*bytes\s+in\s+([\d,]+)\s*blocks",
        re.IGNORECASE,
    ),
}
PID_PREFIX_RE = re.compile(r"^==\d+==\s?", re.MULTILINE)


class ValgrindFrame(BaseModel):
    ip: str = ""
    fn: str = "??"
    file: str = ""
    line: int = 0
    is_user_code: bool = False


class ValgrindErrorItem(BaseModel):
    id: str
    kind: str
    type: str
    what: str
    message: str
    description: str
    bytes_leaked: int = 0
    blocks_leaked: int = 0
    file: str = ""
    line: int = 0
    function: str = ""
    auxwhat: List[str] = Field(default_factory=list)
    stack: List[ValgrindFrame] = Field(default_factory=list)
    frames: List[ValgrindFrame] = Field(default_factory=list)


class HeapSummaryStats(BaseModel):
    in_use_at_exit_bytes: int = 0
    in_use_at_exit_blocks: int = 0
    total_allocs: int = 0
    total_frees: int = 0
    total_bytes_allocated: int = 0


class LeakSummaryStats(BaseModel):
    definitely_lost_bytes: int = 0
    definitely_lost_blocks: int = 0
    indirectly_lost_bytes: int = 0
    indirectly_lost_blocks: int = 0
    possibly_lost_bytes: int = 0
    possibly_lost_blocks: int = 0
    still_reachable_bytes: int = 0
    still_reachable_blocks: int = 0
    suppressed_bytes: int = 0
    suppressed_blocks: int = 0


def _parse_int_commas(raw: str) -> int:
    try:
        return int(raw.replace(",", "").strip())
    except (ValueError, AttributeError):
        return 0


def _parse_valgrind_text_summary(
    raw_log: str,
) -> Tuple[HeapSummaryStats, LeakSummaryStats]:
    heap_stats = HeapSummaryStats()
    leak_stats = LeakSummaryStats()

    in_use_m = IN_USE_AT_EXIT_RE.search(raw_log)
    if in_use_m:
        heap_stats.in_use_at_exit_bytes = _parse_int_commas(in_use_m.group(1))
        heap_stats.in_use_at_exit_blocks = _parse_int_commas(in_use_m.group(2))

    usage_m = TOTAL_HEAP_USAGE_RE.search(raw_log)
    if usage_m:
        heap_stats.total_allocs = _parse_int_commas(usage_m.group(1))
        heap_stats.total_frees = _parse_int_commas(usage_m.group(2))
        heap_stats.total_bytes_allocated = _parse_int_commas(usage_m.group(3))

    for key, pattern in LEAK_CATEGORY_RE.items():
        m = pattern.search(raw_log)
        if m:
            b_val = _parse_int_commas(m.group(1))
            blk_val = _parse_int_commas(m.group(2))
            setattr(leak_stats, f"{key}_bytes", b_val)
            setattr(leak_stats, f"{key}_blocks", blk_val)

    return (heap_stats, leak_stats)


def _parse_valgrind_xml(
    xml_path: Path, user_source_filename: str = "target.c"
) -> List[ValgrindErrorItem]:
    if not xml_path.exists():
        return []

    raw_xml = xml_path.read_text(encoding="utf-8", errors="replace").strip()
    if not raw_xml:
        return []

    # If the target crashed mid-write before closing `</valgrindoutput>`, repair the tail
    if "</valgrindoutput>" not in raw_xml:
        raw_xml += "\n</valgrindoutput>"

    try:
        root = ET.fromstring(raw_xml)
    except ET.ParseError:
        return []

    errors: List[ValgrindErrorItem] = []

    for idx, err_elem in enumerate(root.findall("error")):
        unique_id = (err_elem.findtext("unique") or f"err-{idx}").strip()
        kind = (err_elem.findtext("kind") or "MemoryError").strip()

        xwhat_elem = err_elem.find("xwhat")
        if xwhat_elem is not None:
            what_text = (xwhat_elem.findtext("text") or "").strip()
            leaked_bytes = _parse_int_commas(
                xwhat_elem.findtext("leakedbytes") or "0"
            )
            leaked_blocks = _parse_int_commas(
                xwhat_elem.findtext("leakedblocks") or "0"
            )
        else:
            what_text = (err_elem.findtext("what") or kind).strip()
            leaked_bytes = 0
            leaked_blocks = 0

        auxwhat_list: List[str] = []
        for aux_el in err_elem.findall("auxwhat"):
            if aux_el.text and aux_el.text.strip():
                auxwhat_list.append(aux_el.text.strip())
        for xaux_el in err_elem.findall("xauxwhat"):
            txt = xaux_el.findtext("text")
            if txt and txt.strip():
                auxwhat_list.append(txt.strip())

        frames: List[ValgrindFrame] = []
        primary_file = ""
        primary_line = 0
        primary_fn = ""

        # Parse all stack traces (primary stack first)
        stacks = err_elem.findall("stack")
        if stacks:
            for fr_el in stacks[0].findall("frame"):
                ip_str = (fr_el.findtext("ip") or "").strip()
                fn_str = (fr_el.findtext("fn") or "??").strip()
                file_str = (fr_el.findtext("file") or "").strip()
                line_str = (fr_el.findtext("line") or "0").strip()
                try:
                    line_int = int(line_str)
                except ValueError:
                    line_int = 0

                is_user = (
                    file_str == user_source_filename
                    or file_str.endswith(f"/{user_source_filename}")
                )
                if is_user and primary_line == 0 and line_int > 0:
                    primary_file = user_source_filename
                    primary_line = line_int
                    primary_fn = fn_str

                frames.append(
                    ValgrindFrame(
                        ip=ip_str,
                        fn=fn_str,
                        file=file_str,
                        line=line_int,
                        is_user_code=is_user,
                    )
                )

        if not primary_fn and frames:
            primary_fn = frames[0].fn
            primary_file = frames[0].file
            primary_line = frames[0].line

        errors.append(
            ValgrindErrorItem(
                id=f"{unique_id}-{idx}",
                kind=kind,
                type=kind,
                what=what_text,
                message=what_text,
                description=what_text,
                bytes_leaked=leaked_bytes,
                blocks_leaked=leaked_blocks,
                file=primary_file,
                line=primary_line,
                function=primary_fn,
                auxwhat=auxwhat_list,
                stack=frames,
                frames=frames,
            )
        )

    return errors


def run_valgrind_audit(
    source_code: str, stdin_text: Optional[str] = None
) -> Dict[str, Any]:
    r"""
    Compiles `source_code` in an isolated workspace and runs Valgrind Memcheck.
    Returns a unified dictionary compatible with all frontend audit views.
    """
    if not source_code or not source_code.strip():
        return {
            "status": "compile_error",
            "success": False,
            "is_clean": False,
            "compile_error": "No C source code was provided for Valgrind analysis.",
            "stderr": "No C source code was provided for Valgrind analysis.",
            "stdout": "",
            "raw_output": "",
            "valgrind_output": "",
            "log": "",
            "errors": [],
            "leaks": [],
            "summary": {
                "total_allocs": 0,
                "total_frees": 0,
                "bytes_allocated": 0,
                "definitely_lost": 0,
                "indirectly_lost": 0,
                "possibly_lost": 0,
                "still_reachable": 0,
                "error_count": 0,
                "is_clean": False,
            },
        }

    workdir = TMPFS_ROOT / f"valgrind_{uuid.uuid4().hex[:12]}"
    workdir.mkdir(parents=True, exist_ok=True)

    source_path = workdir / "target.c"
    binary_path = workdir / "target"
    xml_path = workdir / "valgrind.xml"
    log_path = workdir / "valgrind.log"

    try:
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

        compile_proc = subprocess.run(
            compile_cmd,
            capture_output=True,
            text=True,
            timeout=COMPILE_TIMEOUT_SEC,
        )

        if compile_proc.returncode != 0:
            err_msg = compile_proc.stderr or "Compilation failed."
            return {
                "status": "compile_error",
                "success": False,
                "is_clean": False,
                "compile_error": err_msg,
                "stderr": err_msg,
                "stdout": compile_proc.stdout or "",
                "raw_output": err_msg,
                "valgrind_output": err_msg,
                "log": err_msg,
                "errors": [],
                "leaks": [],
                "summary": {
                    "total_allocs": 0,
                    "total_frees": 0,
                    "bytes_allocated": 0,
                    "definitely_lost": 0,
                    "indirectly_lost": 0,
                    "possibly_lost": 0,
                    "still_reachable": 0,
                    "error_count": 0,
                    "is_clean": False,
                },
            }

        stdin_bytes = stdin_text.encode("utf-8") if stdin_text else None

        xml_cmd = [
            "valgrind",
            "--tool=memcheck",
            "--leak-check=full",
            "--show-leak-kinds=all",
            "--track-origins=yes",
            "--xml=yes",
            f"--xml-file={xml_path}",
            str(binary_path),
        ]

        log_cmd = [
            "valgrind",
            "--tool=memcheck",
            "--leak-check=full",
            "--show-leak-kinds=all",
            "--track-origins=yes",
            f"--log-file={log_path}",
            str(binary_path),
        ]

        def _exec_cmd(cmd: List[str]) -> subprocess.CompletedProcess[bytes]:
            return subprocess.run(
                cmd,
                input=stdin_bytes,
                capture_output=True,
                timeout=VALGRIND_TIMEOUT_SEC,
                cwd=str(workdir),
            )

        # Execute XML and human-readable log runs concurrently (~70ms total)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            fut_xml = pool.submit(_exec_cmd, xml_cmd)
            fut_log = pool.submit(_exec_cmd, log_cmd)
            xml_proc = fut_xml.result()
            log_proc = fut_log.result()

        prog_stdout = (log_proc.stdout or b"").decode("utf-8", errors="replace")
        prog_stderr = (log_proc.stderr or b"").decode("utf-8", errors="replace")

        raw_log_text = (
            log_path.read_text(encoding="utf-8", errors="replace")
            if log_path.exists()
            else ""
        )
        clean_log_text = PID_PREFIX_RE.sub("", raw_log_text).strip()

        heap_stats, leak_stats = _parse_valgrind_text_summary(raw_log_text)
        parsed_errors = _parse_valgrind_xml(xml_path, user_source_filename="target.c")

        # Separate leak records vs non-leak memory errors (e.g. InvalidRead, InvalidWrite, InvalidFree, UninitCondition)
        leak_items = [
            e.model_dump()
            for e in parsed_errors
            if e.kind.startswith("Leak_")
        ]
        all_error_items = [e.model_dump() for e in parsed_errors]

        # Backfill leak summary from XML if text summary was truncated by a signal
        if leak_stats.definitely_lost_bytes == 0:
            for e in parsed_errors:
                if e.kind == "Leak_DefinitelyLost":
                    leak_stats.definitely_lost_bytes += e.bytes_leaked
                    leak_stats.definitely_lost_blocks += e.blocks_leaked
                elif e.kind == "Leak_IndirectlyLost":
                    leak_stats.indirectly_lost_bytes += e.bytes_leaked
                    leak_stats.indirectly_lost_blocks += e.blocks_leaked
                elif e.kind == "Leak_PossiblyLost":
                    leak_stats.possibly_lost_bytes += e.bytes_leaked
                    leak_stats.possibly_lost_blocks += e.blocks_leaked
                elif e.kind == "Leak_StillReachable":
                    leak_stats.still_reachable_bytes += e.bytes_leaked
                    leak_stats.still_reachable_blocks += e.blocks_leaked

        total_leaked_bytes = (
            leak_stats.definitely_lost_bytes
            + leak_stats.indirectly_lost_bytes
            + leak_stats.possibly_lost_bytes
            + leak_stats.still_reachable_bytes
        )
        is_clean = (
            len(parsed_errors) == 0
            and total_leaked_bytes == 0
            and heap_stats.in_use_at_exit_bytes == 0
        )

        summary_payload = {
            "total_allocs": heap_stats.total_allocs,
            "total_frees": heap_stats.total_frees,
            "bytes_allocated": heap_stats.total_bytes_allocated,
            "total_bytes_allocated": heap_stats.total_bytes_allocated,
            "in_use_at_exit_bytes": heap_stats.in_use_at_exit_bytes,
            "in_use_at_exit_blocks": heap_stats.in_use_at_exit_blocks,
            "definitely_lost": leak_stats.definitely_lost_bytes,
            "definitely_lost_bytes": leak_stats.definitely_lost_bytes,
            "definitely_lost_blocks": leak_stats.definitely_lost_blocks,
            "indirectly_lost": leak_stats.indirectly_lost_bytes,
            "indirectly_lost_bytes": leak_stats.indirectly_lost_bytes,
            "indirectly_lost_blocks": leak_stats.indirectly_lost_blocks,
            "possibly_lost": leak_stats.possibly_lost_bytes,
            "possibly_lost_bytes": leak_stats.possibly_lost_bytes,
            "possibly_lost_blocks": leak_stats.possibly_lost_blocks,
            "still_reachable": leak_stats.still_reachable_bytes,
            "still_reachable_bytes": leak_stats.still_reachable_bytes,
            "still_reachable_blocks": leak_stats.still_reachable_blocks,
            "suppressed_bytes": leak_stats.suppressed_bytes,
            "suppressed_blocks": leak_stats.suppressed_blocks,
            "error_count": len(parsed_errors),
            "is_clean": is_clean,
        }

        return {
            "status": "completed",
            "success": True,
            "is_clean": is_clean,
            "compile_error": None,
            "exit_code": xml_proc.returncode,
            "stdout": prog_stdout,
            "stderr": prog_stderr,
            "raw_output": raw_log_text,
            "valgrind_output": raw_log_text,
            "clean_log": clean_log_text,
            "log": raw_log_text,
            "heap_summary": heap_stats.model_dump(),
            "leak_summary": leak_stats.model_dump(),
            "summary": summary_payload,
            "total_allocs": heap_stats.total_allocs,
            "total_frees": heap_stats.total_frees,
            "bytes_allocated": heap_stats.total_bytes_allocated,
            "in_use_at_exit_bytes": heap_stats.in_use_at_exit_bytes,
            "in_use_at_exit_blocks": heap_stats.in_use_at_exit_blocks,
            "definitely_lost": leak_stats.definitely_lost_bytes,
            "indirectly_lost": leak_stats.indirectly_lost_bytes,
            "possibly_lost": leak_stats.possibly_lost_bytes,
            "still_reachable": leak_stats.still_reachable_bytes,
            "error_count": len(parsed_errors),
            "errors": all_error_items,
            "leaks": leak_items,
        }

    except subprocess.TimeoutExpired:
        timeout_msg = f"Valgrind execution timed out after {VALGRIND_TIMEOUT_SEC:.0f}s."
        return {
            "status": "timeout",
            "success": False,
            "is_clean": False,
            "compile_error": None,
            "stderr": timeout_msg,
            "stdout": "",
            "raw_output": timeout_msg,
            "valgrind_output": timeout_msg,
            "log": timeout_msg,
            "errors": [
                {
                    "id": "timeout-0",
                    "kind": "TimeoutError",
                    "type": "TimeoutError",
                    "what": timeout_msg,
                    "message": timeout_msg,
                    "description": timeout_msg,
                    "bytes_leaked": 0,
                    "blocks_leaked": 0,
                    "file": "target.c",
                    "line": 1,
                    "function": "main",
                    "auxwhat": [],
                    "stack": [],
                    "frames": [],
                }
            ],
            "leaks": [],
            "summary": {
                "total_allocs": 0,
                "total_frees": 0,
                "bytes_allocated": 0,
                "definitely_lost": 0,
                "indirectly_lost": 0,
                "possibly_lost": 0,
                "still_reachable": 0,
                "error_count": 1,
                "is_clean": False,
            },
        }
    except Exception as exc:
        err_str = f"Internal Valgrind analyzer error: {exc}"
        return {
            "status": "error",
            "success": False,
            "is_clean": False,
            "compile_error": err_str,
            "stderr": err_str,
            "stdout": "",
            "raw_output": err_str,
            "valgrind_output": err_str,
            "log": err_str,
            "errors": [],
            "leaks": [],
            "summary": {
                "total_allocs": 0,
                "total_frees": 0,
                "bytes_allocated": 0,
                "definitely_lost": 0,
                "indirectly_lost": 0,
                "possibly_lost": 0,
                "still_reachable": 0,
                "error_count": 0,
                "is_clean": False,
            },
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# FastAPI Router for modular inclusion
router = APIRouter()


async def _extract_audit_request(request: Request) -> Tuple[str, Optional[str]]:
    raw_bytes = await request.body()
    raw_text = raw_bytes.decode("utf-8", errors="replace")
    try:
        import json

        data = json.loads(raw_text)
        if isinstance(data, dict):
            code = (
                data.get("code")
                or data.get("source_code")
                or data.get("source")
                or data.get("c_code")
                or ""
            )
            stdin_val = data.get("stdin") or data.get("input")
            return (
                str(code),
                str(stdin_val) if stdin_val is not None else None,
            )
    except Exception:
        pass
    return (raw_text, None)


@router.post("/api/analyze/memory")
@router.post("/analyze/memory")
@router.post("/api/valgrind")
@router.post("/valgrind")
@router.post("/api/analyze/valgrind")
@router.post("/analyze/valgrind")
@router.post("/api/audit")
@router.post("/audit")
async def handle_valgrind_audit_http(request: Request) -> Dict[str, Any]:
    import asyncio

    source_code, stdin_text = await _extract_audit_request(request)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, run_valgrind_audit, source_code, stdin_text
    )
    return result
