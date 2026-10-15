#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${TMPFS_PATH:-/sandbox/workspace}"

echo "[Bootstrap] Initializing C-Memory-Studio Container..."
echo "[Bootstrap] Running as user: $(id)"

# 1. Prevent core dumps from filling up the 512MB tmpfs RAM disk when student code segfaults
ulimit -c 0

# 2. Verify workspace exists and is writable
if [ ! -d "${WORKSPACE}" ] || [ ! -w "${WORKSPACE}" ]; then
    echo "[ERROR] Workspace ${WORKSPACE} is missing or not writable by $(whoami)!" >&2
    exit 1
fi

# 3. Verify tmpfs is mounted with 'exec' permission
# Without 'exec', GCC will compile binaries, but GDB/Valgrind will fail with EACCES.
TEST_BIN="${WORKSPACE}/.exec_check_$$"
cat << 'EOF' > "${TEST_BIN}.c"
int main(void) { return 0; }
EOF

if gcc "${TEST_BIN}.c" -o "${TEST_BIN}" 2>/dev/null; then
    if ! "${TEST_BIN}" 2>/dev/null; then
        rm -f "${TEST_BIN}" "${TEST_BIN}.c"
        echo "[FATAL] ${WORKSPACE} is mounted with 'noexec'. Compiled binaries cannot run!" >&2
        exit 1
    fi
    rm -f "${TEST_BIN}" "${TEST_BIN}.c"
    echo "[Bootstrap] Verified tmpfs compile-and-execute permissions on ${WORKSPACE}."
else
    echo "[FATAL] GCC failed to compile test binary in ${WORKSPACE}." >&2
    exit 1
fi

# 4. Clean any stale artifacts in tmpfs before launching API
find "${WORKSPACE}" -mindepth 1 -delete

echo "[Bootstrap] Handing over execution to: $*"
exec "$@"
