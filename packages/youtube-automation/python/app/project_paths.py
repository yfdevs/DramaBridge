"""Stable project/data paths, independent of the source-code directory."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def credential_path(root, name):
    root = Path(root)
    preferred = root / 'data' / 'credentials' / name
    legacy = root / name
    if preferred.exists() or (preferred.parent.is_dir() and not legacy.exists()):
        return preferred
    return legacy


def prepare_layout(root=ROOT):
    """Move legacy credentials without overwriting any existing destination."""
    root = Path(root).resolve()
    target = root / 'data' / 'credentials'
    if not target.resolve().is_relative_to(root):
        raise ValueError('Credentials directory must stay inside the project')
    target.mkdir(parents=True, exist_ok=True)
    moved = []
    for name in ('client_secret.json', 'token.json', 'uploaded.json'):
        source, destination = root / name, target / name
        if source.is_file() and not source.is_symlink() and not destination.exists():
            source.replace(destination)
            moved.append(name)
    return moved
