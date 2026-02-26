import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent


@pytest.fixture
def tools_root() -> Path:
    return ROOT


@pytest.fixture
def load_module(tools_root):
    def _load(rel_path: str, module_name: str | None = None):
        path = tools_root / rel_path
        name = module_name or path.stem.replace("-", "_")

        module_dir = str(path.parent)
        if module_dir not in sys.path:
            sys.path.insert(0, module_dir)

        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Failed to load module from {path}")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        return mod

    return _load


@pytest.fixture
def fake_subprocess_ok():
    def _factory(stdout="", stderr="", returncode=0):
        return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)

    return _factory
