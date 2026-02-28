#!/usr/bin/env python3
import importlib.util
import json
import sys
from pathlib import Path


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_fallback_to_keyword_when_vector_unavailable(tmp_path, monkeypatch, capsys):
    mod = load_module(Path('/Users/hd/openclaw/tools/memory/safe-memory-search.py'), 'safe_memory_search_test1')

    monkeypatch.setattr(mod, 'WORKSPACE', tmp_path)
    monkeypatch.setattr(mod, 'STATE_PATH', tmp_path / 'memory' / 'vector-memory-health-state.json')
    (tmp_path / 'memory').mkdir(parents=True, exist_ok=True)
    (tmp_path / 'MEMORY.md').write_text('Alpha beta gamma\nvector outage handling\n', encoding='utf-8')

    def fake_vector_search(query, max_results):
        return None, 'embedding error 429 failed quota'

    monkeypatch.setattr(mod, 'vector_search', fake_vector_search)
    monkeypatch.setattr(sys, 'argv', ['safe-memory-search.py', 'vector outage', '--json'])
    assert mod.main() == 0

    out = json.loads(capsys.readouterr().out)
    assert out['mode'] == 'keyword_fallback'
    assert isinstance(out['results'], list)


def test_output_includes_mode_vector_and_keyword_fallback(tmp_path, monkeypatch, capsys):
    mod = load_module(Path('/Users/hd/openclaw/tools/memory/safe-memory-search.py'), 'safe_memory_search_test2')
    monkeypatch.setattr(mod, 'WORKSPACE', tmp_path)
    monkeypatch.setattr(mod, 'STATE_PATH', tmp_path / 'memory' / 'vector-memory-health-state.json')

    def ok_vector(query, max_results):
        return [{'snippet': 'hit'}], ''

    monkeypatch.setattr(mod, 'vector_search', ok_vector)
    monkeypatch.setattr(sys, 'argv', ['safe-memory-search.py', 'anything', '--json'])
    assert mod.main() == 0
    out1 = json.loads(capsys.readouterr().out)
    assert out1['mode'] == 'vector'

    def bad_vector(query, max_results):
        return None, 'failed'

    monkeypatch.setattr(mod, 'vector_search', bad_vector)
    monkeypatch.setattr(sys, 'argv', ['safe-memory-search.py', 'anything', '--json'])
    assert mod.main() == 0
    out2 = json.loads(capsys.readouterr().out)
    assert out2['mode'] == 'keyword_fallback'
