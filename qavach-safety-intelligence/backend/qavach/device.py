"""Which device the models run on, one rule for the detectors and the tracker.

QAVACH_DEVICE: `auto` (default) uses the first NVIDIA GPU if there is one, then Apple's GPU, then the CPU. Set it to
`cpu`, `mps`, `cuda`, or `cuda:1` to force one. A device that is not available falls back to the CPU with a message on
stderr, so a wrong setting slows detection down instead of stopping it. Needs no import of the rest of the service, so
the tracker worker (a separate Python environment) can use it too.
"""
import os
import sys

_cache = {}


def pick_device(allow_mps=True):
    """'cuda:0', 'cuda:N', 'mps' or 'cpu'. The tracker passes allow_mps=False: its re-identification runs on CUDA or CPU."""
    key = (os.environ.get('QAVACH_DEVICE', ''), allow_mps)
    if key in _cache:
        return _cache[key]
    import torch
    want = (key[0].strip().lower() or 'auto')
    cuda, mps = torch.cuda.is_available(), torch.backends.mps.is_available()
    if want == 'auto':
        device = 'cuda:0' if cuda else 'mps' if (mps and allow_mps) else 'cpu'
    elif want.startswith('cuda'):
        device = want if want != 'cuda' else 'cuda:0'
        if not cuda or (':' in device and int(device.split(':')[1] or 0) >= torch.cuda.device_count()):
            print(f'QAVACH_DEVICE={want} is not available here; using the CPU', file=sys.stderr)
            device = 'cpu'
    elif want == 'mps':
        device = 'mps' if (mps and allow_mps) else 'cpu'
        if device == 'cpu':
            print('QAVACH_DEVICE=mps is not available here; using the CPU', file=sys.stderr)
    elif want == 'cpu':
        device = 'cpu'
    else:
        print(f'QAVACH_DEVICE={want} is not understood (use auto, cpu, mps, cuda or cuda:N); using auto', file=sys.stderr)
        os.environ['QAVACH_DEVICE'] = ''
        return pick_device(allow_mps)
    _cache[key] = device
    return device


def half_precision(device):
    """Half precision roughly doubles speed on an NVIDIA GPU; the CPU and Apple's GPU stay in full precision."""
    return device.startswith('cuda')
