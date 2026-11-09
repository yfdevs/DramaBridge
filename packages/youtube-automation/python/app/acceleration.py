"""Hardware selection and real compute checks; importing this module is cheap."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from project_paths import ROOT
from windows_job import hidden_process_options

PYTORCH_INDEX = 'https://download.pytorch.org/whl/'
AMD_ROOT = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/'
AMD_MODELS = {'rx 9070', 'rx 9070 xt', 'rx 9060 xt', 'rx 7900 xtx',
              'rx 7700', 'ai pro r9700', 'pro w7900', 'pro w7900 dual slot'}


def detect_hardware():
    hardware = {'gpus': [], 'nvidia': None, 'windows_build': sys.getwindowsversion().build if os.name == 'nt' else 0}
    if os.name != 'nt':
        return hardware
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-Command',
            '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '
            '@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion) | ConvertTo-Json -Compress'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20, **hidden_process_options())
        if result.returncode == 0 and result.stdout.strip():
            values = json.loads(result.stdout)
            hardware['gpus'] = values if isinstance(values, list) else [values]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    smi = shutil.which('nvidia-smi')
    if not smi:
        candidate = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/nvidia-smi.exe'
        smi = str(candidate) if candidate.is_file() else None
    if smi:
        try:
            result = subprocess.run([smi], capture_output=True, text=True, errors='replace', timeout=10, **hidden_process_options())
            match = re.search(r'CUDA Version:\s*(\d+)\.(\d+)', result.stdout)
            caps = subprocess.run([smi, '--query-gpu=compute_cap', '--format=csv,noheader'],
                capture_output=True, text=True, errors='replace', timeout=10, **hidden_process_options())
            capabilities = [float(value) for value in caps.stdout.splitlines() if re.fullmatch(r'\d+\.\d+', value.strip())]
            if result.returncode == 0:
                hardware['nvidia'] = {'cuda': [int(n) for n in match.groups()] if match else None,
                                      'compute_capability': max(capabilities) if capabilities else None}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    return hardware


def installation_plan(hardware, mode='auto'):
    """Only select stable vendor distributions supported by detected hardware."""
    if mode == 'cpu':
        return {'backend': 'cpu', 'index': PYTORCH_INDEX + 'cpu', 'packages': ['torch==2.11.0']}
    names = [re.sub(r'\(tm\)|\(r\)|™|®', '', gpu.get('Name', '').lower()) for gpu in hardware['gpus']]
    nvidia = hardware.get('nvidia')
    if mode in ('auto', 'cuda') and nvidia and nvidia.get('cuda'):
        supported = tuple(nvidia['cuda'])
        capability = nvidia.get('compute_capability')
        if supported >= (12, 8) and (capability is None or capability >= 7.5):
            index, version = 'cu128', '2.11.0'
        elif supported >= (12, 6) and (capability is None or capability >= 7.5):
            index, version = 'cu126', '2.11.0'
        elif supported >= (11, 8) and (capability is None or 5 <= capability < 10):
            index, version = 'cu118', '2.7.1'
        else:
            return {'backend': 'cpu', 'reason': 'NVIDIA 驱动或计算架构不满足已配置的稳定版运行时，请更新官方驱动。'}
        return {'backend': 'cuda', 'index': PYTORCH_INDEX + index,
                'packages': [f'torch=={version}']}
    if mode in ('auto', 'rocm') and hardware.get('windows_build', 0) >= 22000:
        if any(name.replace('amd ', '').replace('radeon ', '').strip() in AMD_MODELS for name in names):
            return {'backend': 'rocm', 'sdk': [AMD_ROOT + name for name in (
                'rocm_sdk_core-7.2.1-py3-none-win_amd64.whl',
                'rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl',
                'rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl', 'rocm-7.2.1.tar.gz')],
                'packages': [AMD_ROOT + 'torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl'],
                'reason': '需要 AMD 26.2.2 或该版本对应的兼容驱动；安装后会实际检测。'}
    if mode in ('auto', 'xpu') and hardware.get('windows_build', 0) >= 22000 and any('intel' in name and 'arc' in name for name in names):
        return {'backend': 'xpu', 'index': PYTORCH_INDEX + 'xpu',
                'packages': ['torch==2.11.0']}
    reason = '当前硬件未匹配已配置的 AI GPU 运行时，使用 CPU；视频硬件编码另行实测。'
    if any('nvidia' in name for name in names):
        reason = '检测到 NVIDIA 显卡，但驱动或 nvidia-smi 未就绪；请更新 NVIDIA 官方驱动后重新运行 install.bat。'
    return {'backend': 'cpu', 'reason': reason}


def kernel_check(torch, device):
    """Check operators used by Demucs, not just a CUDA/XPU availability flag."""
    with torch.no_grad():
        values = torch.ones(16, 16, device=device)
        assert (values @ values).mean().item() == 16
        audio = torch.ones(1, 2, 4096, device=device)
        spectrum = torch.fft.rfft(audio)
        restored = torch.fft.irfft(spectrum, n=4096)
        assert torch.isfinite(restored).all().item()
        torch.testing.assert_close(restored, audio, rtol=1e-5, atol=1e-6)
        torch.nn.functional.conv1d(audio, torch.ones(2, 2, 3, device=device))
    backend = getattr(torch, device.split(':')[0], None)
    if backend and hasattr(backend, 'synchronize'):
        backend.synchronize()


def verified_device(torch, preference='auto'):
    errors = []
    if preference == 'cpu':
        return 'cpu', errors
    for name in ('cuda', 'xpu'):
        if preference != 'auto' and not preference.startswith(name):
            continue
        backend = getattr(torch, name, None)
        try:
            if backend and backend.is_available():
                device = preference if preference.startswith(name) else name
                kernel_check(torch, device)
                return device, errors
        except (RuntimeError, AssertionError, OSError) as exc:
            errors.append(f'{name}: {exc}')
    return 'cpu', errors


def runtime_probe(preference='auto', model=False):
    result = {'torch_available': False, 'device': 'cpu', 'errors': []}
    try:
        import torch
        result.update(torch_available=True, torch_version=torch.__version__)
        device, errors = verified_device(torch, preference)
        result.update(device=device, errors=errors, backend='rocm' if device.startswith('cuda') and torch.version.hip else device.split(':')[0])
        if device != 'cpu':
            result['name'] = getattr(torch, device.split(':')[0]).get_device_name()
        if model and device != 'cpu':
            from separation_worker import prefer_cached_model, _vocal_only_model
            if prefer_cached_model():
                from demucs.api import Separator
                separator = Separator(model='htdemucs', device=device, shifts=1, overlap=.25, jobs=0, progress=False)
                separator._model = _vocal_only_model(separator.model)
                _, sources = separator.separate_tensor(torch.zeros(2, separator.samplerate), sr=separator.samplerate)
                assert sources['vocals'].shape == (2, separator.samplerate)
                assert torch.isfinite(sources['vocals']).all().item()
                result['model_check'] = 'passed'
            else:
                result['model_check'] = 'deferred_until_model_download'
    except Exception as exc:
        result['errors'].append(str(exc))
        if model:
            result['model_check'] = 'failed'
        result['device'] = 'cpu'
    return result


def worker_device(torch):
    preference = 'auto'
    device, errors = verified_device(torch, preference)
    for error in errors:
        print(f'GPU 检测未通过，继续使用 CPU：{error}', flush=True)
    return device


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--device', default='auto')
    parser.add_argument('--model', action='store_true')
    args = parser.parse_args()
    print(json.dumps(runtime_probe(args.device, args.model), ensure_ascii=False))
