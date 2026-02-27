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


def test_chunks_zero_triggers_fallback_and_state_file(tmp_path, monkeypatch, capsys):
    mod = load_module(Path('/Users/hd/clawd/tools/memory/vector-health-gate.py'), 'vector_health_gate_test1')
    state_path = tmp_path / 'vector-state.json'
    monkeypatch.setattr(mod, 'STATE_PATH', state_path)

    def fake_run(cmd, timeout=120):
        class R:
            returncode = 0
            stdout = ''
            stderr = ''

        r = R()
        if cmd[:3] == ['openclaw', 'memory', 'status']:
            r.stdout = json.dumps([{'status': {'files': 2, 'chunks': 0, 'provider': 'x', 'model': 'y'}}])
        elif cmd[:3] == ['openclaw', 'memory', 'search']:
            r.stdout = '[]'
        elif cmd[:3] == ['openclaw', 'memory', 'index']:
            r.stdout = 'ok'
        elif 'SELECT COUNT(*) FROM cortana_immune_incidents' in ' '.join(cmd):
            r.stdout = '0\n'
        return r

    monkeypatch.setattr(mod, 'run', fake_run)
    monkeypatch.setattr(sys, 'argv', ['vector-health-gate.py', '--json'])

    rc = mod.main()
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out['fallback_mode'] is True
    assert out['reindex_queued'] is True
    assert state_path.exists()


def test_three_consecutive_429_triggers_alert_mode(tmp_path, monkeypatch, capsys):
    mod = load_module(Path('/Users/hd/clawd/tools/memory/vector-health-gate.py'), 'vector_health_gate_test2')
    state_path = tmp_path / 'vector-state.json'
    monkeypatch.setattr(mod, 'STATE_PATH', state_path)

    def fake_run(cmd, timeout=120):
        class R:
            returncode = 0
            stdout = ''
            stderr = ''

        r = R()
        joined = ' '.join(cmd)
        if cmd[:3] == ['openclaw', 'memory', 'status']:
            r.stdout = json.dumps([{'status': {'files': 7, 'chunks': 9, 'provider': 'p', 'model': 'm'}}])
        elif cmd[:3] == ['openclaw', 'memory', 'search']:
            r.stdout = 'error: embedding failed with 429 resource_exhausted quota'
            r.stderr = 'failed'
        elif 'SELECT COUNT(*) FROM cortana_immune_incidents' in joined:
            r.stdout = '0\n'
        return r

    monkeypatch.setattr(mod, 'run', fake_run)

    for _ in range(3):
        monkeypatch.setattr(sys, 'argv', ['vector-health-gate.py', '--json'])
        assert mod.main() == 0
        capsys.readouterr()

    state = json.loads(state_path.read_text())
    assert state['consecutive_embedding_429'] >= 3
    assert state['fallback_mode'] is True
    assert state['reindex_queued'] is True


def test_state_save_and_read(tmp_path, monkeypatch):
    mod = load_module(Path('/Users/hd/clawd/tools/memory/vector-health-gate.py'), 'vector_health_gate_test3')
    state_path = tmp_path / 'vector-state.json'
    monkeypatch.setattr(mod, 'STATE_PATH', state_path)

    initial = mod.load_state()
    assert initial['consecutive_embedding_429'] == 0

    payload = {'consecutive_embedding_429': 2, 'fallback_mode': True, 'reindex_queued': False}
    mod.save_state(payload)
    loaded = mod.load_state()
    assert loaded == payload
