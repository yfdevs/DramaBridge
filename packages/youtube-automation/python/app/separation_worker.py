"""Isolated Demucs worker: local model cache first, measured startup, vocals only."""
import argparse
import os
import random
import gc
from pathlib import Path

from pipeline_events import timed_stage
from acceleration import worker_device


def _separate_with_fallback(separator, wav, device, torch):
    state = random.getstate()
    try:
        return separator.separate_audio_file(wav)
    except RuntimeError as exc:
        if device == 'cpu':
            raise
        print(f'GPU 推理未完成，使用相同模型和参数改用 CPU 重试：{str(exc)[:1000]}', flush=True)
    # Release the traceback before freeing the failed attempt's device buffers.
    separator.model.to('cpu')
    separator.update_parameter(device='cpu')
    gc.collect()
    backend = getattr(torch, device.split(':')[0], None)
    if backend and hasattr(backend, 'empty_cache'):
        backend.empty_cache()
    random.setstate(state)
    return separator.separate_audio_file(wav)


def _vocal_only_model(model):
    """Keep full per-window inference, but accumulate only vocals for a long track.

    Demucs applies the same overlap/shift averaging independently to each stem.
    Selecting vocals after each forward pass avoids allocating four full-length
    tracks (and their normalization temporaries) when only vocals are saved.
    """
    import torch
    from demucs.apply import BagOfModels

    if isinstance(model, BagOfModels):
        weights = [[weight[submodel.sources.index('vocals')]]
                   for submodel, weight in zip(model.models, model.weights)]
        return BagOfModels([_vocal_only_model(submodel) for submodel in model.models], weights=weights)

    class VocalOutput(torch.nn.Module):
        def __init__(self, original):
            super().__init__()
            self.original = original
            self.index = original.sources.index('vocals')
            self.sources = ['vocals']
            self.samplerate = original.samplerate
            self.audio_channels = original.audio_channels
            self.segment = original.segment

        def __getattr__(self, name):
            try:
                return super().__getattr__(name)
            except AttributeError:
                # Preserve valid_length and other architecture-specific helpers.
                return getattr(super().__getattr__('original'), name)

        def forward(self, mixture):
            return self.original(mixture)[:, self.index:self.index + 1]

    return VocalOutput(model)


def prefer_cached_model():
    """Use HF offline mode only after checking all files for this model exist."""
    try:
        import yaml
        from huggingface_hub import try_to_load_from_cache, constants
        repo = "adefossez/HTDemucs"
        definition = try_to_load_from_cache(repo, "htdemucs.yaml")
        if not isinstance(definition, str) or not Path(definition).is_file():
            return False
        bag = yaml.safe_load(Path(definition).read_text(encoding="utf-8"))
        for signature in bag["models"]:
            path = try_to_load_from_cache(repo, f"{signature}.safetensors")
            if not isinstance(path, str) or not Path(path).is_file():
                return False
        os.environ["HF_HUB_OFFLINE"] = "1"
        constants.HF_HUB_OFFLINE = True
        return True
    except (ImportError, OSError, KeyError, TypeError, ValueError):
        return False


def run(wav, out_dir, fast=False):
    with timed_stage("loading_model", message="加载 htdemucs，优先使用完整本地缓存"):
        import torch
        from demucs.api import Separator, save_audio

        cached = prefer_cached_model()
        device = worker_device(torch)
        threads = str(min(os.cpu_count() or 4, 8))
        if threads:
            torch.set_num_threads(max(1, min(64, int(threads))))
        overlap = 0.1 if fast else 0.25
        print(f"分离配置：htdemucs / {device} / shifts=1 / overlap={overlap} / "
              f"CPU 线程={torch.get_num_threads()} / {'本地模型缓存' if cached else '检查模型下载'}", flush=True)
        separator = Separator(model="htdemucs", device=device, shifts=1, overlap=overlap, jobs=0, progress=True)
        separator._model = _vocal_only_model(separator.model)
        print("结果累积：仅人声；每个窗口仍执行完整模型推理", flush=True)

    with timed_stage("separating", message=f"人声分离（{device}）"):
        _, sources = _separate_with_fallback(separator, wav, device, torch)
    with timed_stage("saving_audio", message="只保存人声轨"):
        target = out_dir / "htdemucs" / wav.stem / "vocals.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name("vocals.partial.wav")
        save_audio(sources["vocals"], partial, samplerate=separator.samplerate)
        partial.replace(target)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args()
    run(args.wav, args.out_dir, args.fast)
