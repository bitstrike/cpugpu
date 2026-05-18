#!/bin/bash
# Allocate VRAM using CUDA to test the applet's VRAM bar.
# Requires: nvidia-smi, python3, pytorch (or uses fallback with vulkan-tools)
#
# Usage: ./test-vram.sh [megabytes]
# Default: 4000 MB (~25% of 16GB)
# Press Ctrl+C to release and exit.

MB=${1:-4000}

echo "Attempting to allocate ${MB} MB of VRAM..."
echo "Press Ctrl+C to release and exit."
echo ""

# Method 1: PyTorch (most common CUDA allocator)
if python3 -c "import torch" 2>/dev/null; then
    echo "Using PyTorch..."
    python3 -c "
import torch, signal, sys

def cleanup(sig, frame):
    print('\nReleasing VRAM...')
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)

mb = ${MB}
elements = (mb * 1024 * 1024) // 4  # float32 = 4 bytes
t = torch.zeros(elements, dtype=torch.float32, device='cuda')
print(f'Allocated {mb} MB on GPU')
print('Holding... Ctrl+C to release')
signal.pause()
"
    exit $?
fi

# Method 2: Raw CUDA via ctypes
if [ -f /usr/lib/x86_64-linux-gnu/libcuda.so.1 ] || [ -f /usr/lib/libcuda.so.1 ]; then
    echo "Using CUDA driver API directly..."
    python3 -c "
import ctypes, signal, sys

def cleanup(sig, frame):
    print('\nReleasing VRAM...')
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)

libcuda = ctypes.CDLL('libcuda.so.1')
libcuda.cuInit(0)

device = ctypes.c_int()
libcuda.cuDeviceGet(ctypes.byref(device), 0)

context = ctypes.c_void_p()
libcuda.cuCtxCreate_v2(ctypes.byref(context), 0, device)

mb = ${MB}
size = mb * 1024 * 1024
ptr = ctypes.c_uint64()
result = libcuda.cuMemAlloc_v2(ctypes.byref(ptr), ctypes.c_size_t(size))
if result != 0:
    print(f'cuMemAlloc failed with error {result}')
    sys.exit(1)

print(f'Allocated {mb} MB on GPU')
print('Holding... Ctrl+C to release')
signal.pause()
"
    exit $?
fi

echo "No CUDA allocator found. Install pytorch: pip install torch"
exit 1
