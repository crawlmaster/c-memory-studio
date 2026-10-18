#!/usr/bin/env python3
r"""
backend/src/main.py

FastAPI WebSocket & REST Entrypoint for C-Memory-Studio.
1. Mounts the Valgrind Memcheck & Leak Audit router (`src.analyzer.valgrind.router`)
   across `/api/analyze/memory`, `/analyze/memory`, `/api/valgrind`, `/valgrind`,
   `/api/analyze/valgrind`, and `/api/audit`.
2. Streams DWARF/GDB-MI execution snapshots asynchronously via `/ws/trace` and
   `/api/ws/trace` without blocking the FastAPI event loop.
"""

import asyncio
import json
import logging
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from src.analyzer.valgrind import router as valgrind_router
from src.debugger.gdb_engine import (
    GDBTracer,
    TMPFS_ROOT,
    compile_c_source,
    run_trace_session,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("c-memory-studio.main")

app = FastAPI(
    title="C-Memory-Studio Backend",
    version="2.2.0",
    description="Deterministic DWARF/GDB-MI Memory Visualizer & Valgrind Audit Engine",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register Valgrind Memcheck & Leak Audit HTTP POST routes
app.include_router(valgrind_router)


def _extract_code_and_stdin(raw_message: str) -> Tuple[str, Optional[str]]:
    r"""
    Extracts `(source_code, stdin_text)` from a JSON WebSocket payload
    or falls back to treating `raw_message` as raw C source code.
    """
    try:
        data = json.loads(raw_message)
        if isinstance(data, dict):
            code = (
                data.get("code")
                or data.get("source_code")
                or data.get("source")
                or data.get("c_code")
                or ""
            )
            stdin_val = data.get("stdin") or data.get("input")
            return (str(code), str(stdin_val) if stdin_val is not None else None)
    except json.JSONDecodeError:
        pass
    return (raw_message, None)


@app.get("/")
@app.get("/health")
@app.get("/api/health")
async def health_check() -> Dict[str, str]:
    return {"status": "ok", "service": "c-memory-studio-backend"}


async def _handle_trace_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()

    cancel_event = threading.Event()
    tracer_holder: List[GDBTracer] = []
    session_workdir = TMPFS_ROOT / f"session_{uuid.uuid4().hex[:12]}"
    worker_future: Optional[asyncio.Future[Any]] = None

    try:
        raw_msg = await websocket.receive_text()
        source_code, stdin_text = _extract_code_and_stdin(raw_msg)

        if not source_code.strip():
            await websocket.send_json(
                {
                    "event": "error",
                    "status": "error",
                    "error_type": "EmptySourceError",
                    "detail": "No C source code was provided for tracing.",
                }
            )
            return

        session_workdir.mkdir(parents=True, exist_ok=True)

        ok, binary_path, source_path, stderr_txt = await loop.run_in_executor(
            None, compile_c_source, source_code, session_workdir
        )

        if not ok:
            await websocket.send_json(
                {
                    "event": "compile_error",
                    "status": "compile_error",
                    "error_type": "CompilationError",
                    "detail": stderr_txt,
                    "stderr": stderr_txt,
                }
            )
            return

        stdin_path: Optional[Path] = None
        if stdin_text:
            stdin_path = session_workdir / "stdin.txt"
            stdin_path.write_text(stdin_text, encoding="utf-8")

        snapshot_queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

        worker_future = loop.run_in_executor(
            None,
            run_trace_session,
            binary_path,
            source_path,
            stdin_path,
            snapshot_queue,
            loop,
            cancel_event,
            tracer_holder,
        )

        while True:
            item = await snapshot_queue.get()
            if item is None:
                break
            await websocket.send_json(item)
            if item.get("event") in {"completed", "error", "compile_error"}:
                break

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected; cancelling active GDB trace.")
        cancel_event.set()
    except asyncio.CancelledError:
        logger.info("WebSocket handler task cancelled.")
        cancel_event.set()
    except Exception as exc:
        logger.exception("Unhandled error in WebSocket trace handler: %s", exc)
        cancel_event.set()
        try:
            await websocket.send_json(
                {
                    "event": "error",
                    "status": "error",
                    "error_type": type(exc).__name__,
                    "detail": str(exc),
                }
            )
        except Exception:
            pass
    finally:
        cancel_event.set()
        if worker_future is not None and not worker_future.done():
            worker_future.cancel()

        def _cleanup_resources() -> None:
            for t in list(tracer_holder):
                try:
                    t.close()
                except Exception:
                    pass
            shutil.rmtree(session_workdir, ignore_errors=True)

        loop.run_in_executor(None, _cleanup_resources)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/trace")
async def websocket_trace_endpoint(websocket: WebSocket) -> None:
    await _handle_trace_websocket(websocket)


@app.websocket("/api/ws/trace")
async def websocket_api_trace_endpoint(websocket: WebSocket) -> None:
    await _handle_trace_websocket(websocket)
