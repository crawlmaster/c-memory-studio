#!/usr/bin/env python3
"""
backend/src/main.py

Main FastAPI application entry point for C-Memory-Studio.
Routes:
  - WS   /ws/trace           -> src.debugger.gdb_engine
  - POST /api/analyze/memory -> src.analyzer.valgrind
"""

import asyncio
import os
import shutil
import traceback
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.analyzer.valgrind import ValgrindAuditResponse, run_memory_audit
from src.debugger.gdb_engine import TMPFS_ROOT, compile_c_source, run_trace_session

app = FastAPI(title="C-Memory-Studio Tracer API", version="1.0.0")

# ==============================================================================
# CORS Middleware Configuration
# ==============================================================================

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "*",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)


@app.exception_handler(Exception)
async def global_cors_safe_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    origin = request.headers.get("origin") or "*"
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "success": False,
            "runtime_error": f"Internal Server Error: {type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
        },
        headers={
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        },
    )


# ==============================================================================
# Request Schemas
# ==============================================================================

class TraceRequest(BaseModel):
    action: Optional[str] = Field(default="start", description="WebSocket action trigger")
    code: str = Field(..., description="Raw C source code to compile and trace")
    stdin: str = Field(default="", description="Optional standard input for the program")


class MemoryAnalyzeRequest(BaseModel):
    code: str = Field(..., min_length=1, description="C source code to compile and audit")
    stdin: str = Field(default="", description="Optional standard input passed to the binary")


# ==============================================================================
# Endpoints
# ==============================================================================

@app.websocket("/ws/trace")
async def websocket_trace_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session_dir = TMPFS_ROOT / f"run_{uuid.uuid4().hex[:8]}"
    session_dir.mkdir(parents=True, exist_ok=True)

    try:
        raw_payload = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
        req = TraceRequest(**raw_payload)

        success, binary_path, source_path, stderr = await asyncio.to_thread(
            compile_c_source, req.code, TMPFS_ROOT
        )

        if not success:
            await websocket.send_json({
                "event": "compile_error",
                "stderr": stderr,
            })
            await websocket.close(code=1000)
            return

        stdin_path: Optional[Path] = None
        if req.stdin:
            stdin_path = session_dir / "stdin.txt"
            stdin_path.write_text(req.stdin, encoding="utf-8")

        snapshot_queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        tracer_future = loop.run_in_executor(
            None,
            run_trace_session,
            binary_path,
            source_path,
            stdin_path,
            snapshot_queue,
            loop,
        )

        while True:
            item = await snapshot_queue.get()
            if item is None:
                break
            await websocket.send_json(item)

        await tracer_future
        await websocket.close(code=1000)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({
                "event": "error",
                "error_type": type(exc).__name__,
                "detail": str(exc),
            })
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        shutil.rmtree(session_dir, ignore_errors=True)


@app.post(
    "/api/analyze/memory",
    response_model=ValgrindAuditResponse,
    responses={
        200: {"description": "Valgrind analysis completed successfully"},
        400: {"description": "GCC compilation failed"},
        500: {"description": "Internal execution failure"},
    },
)
async def analyze_memory_endpoint(
    payload: MemoryAnalyzeRequest,
    request: Request,
) -> JSONResponse:
    origin = request.headers.get("origin") or "*"
    cors_headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    }

    try:
        result: ValgrindAuditResponse = await asyncio.to_thread(
            run_memory_audit,
            payload.code,
            payload.stdin,
        )

        if not result.success:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "success": False,
                    "compilation_error": result.compilation_error,
                },
                headers=cors_headers,
            )

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=result.model_dump(exclude_none=True),
            headers=cors_headers,
        )

    except Exception as exc:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "success": False,
                "runtime_error": f"Valgrind execution failed: {type(exc).__name__}: {exc}",
            },
            headers=cors_headers,
        )
