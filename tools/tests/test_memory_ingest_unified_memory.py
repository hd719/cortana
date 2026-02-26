from datetime import datetime, timezone


def test_fp_stable_and_order_sensitive(load_module):
    mod = load_module("memory/ingest_unified_memory.py", "ingest_unified_memory")
    a = mod.fp("x", "y")
    b = mod.fp("x", "y")
    c = mod.fp("y", "x")
    assert a == b
    assert a != c
    assert len(a) == 32


def test_quality_gate_disabled_promotes(load_module):
    mod = load_module("memory/ingest_unified_memory.py", "ingest_unified_memory_qg")
    out = mod.quality_gate("hello", enabled=False, dry=True)
    assert out["verdict"] == "promote"


def test_quality_gate_missing_script_promotes(monkeypatch, load_module):
    mod = load_module("memory/ingest_unified_memory.py", "ingest_unified_memory_missing_gate")

    class MissingGate:
        def exists(self):
            return False

    monkeypatch.setattr(mod, "WORKSPACE", mod.Path("/tmp/does-not-exist"))
    out = mod.quality_gate("abc", enabled=True, dry=False)
    assert out["verdict"] == "promote"
    assert out["reason"] == "gate_missing"


def test_ingest_feedback_dry_run_counts_rows(monkeypatch, load_module):
    mod = load_module("memory/ingest_unified_memory.py", "ingest_unified_memory_feedback")

    rows = "1|2026-02-25T10:00:00+00:00|preference|ctx1|lesson1\n2|2026-02-25T11:00:00+00:00|fact|ctx2|lesson2"

    def fake_psql(sql, capture=False):
        assert "FROM cortana_feedback" in sql
        return rows

    monkeypatch.setattr(mod, "psql", fake_psql)
    c = {"e": 0, "s": 0, "p": 0, "v": 0}
    mod.ingest_feedback(run_id=-1, since=datetime.now(timezone.utc), c=c, dry=True)
    assert c == {"e": 2, "s": 2, "p": 2, "v": 6}


def test_ingest_feedback_skips_archived_via_quality_gate(monkeypatch, load_module):
    mod = load_module("memory/ingest_unified_memory.py", "ingest_unified_memory_feedback_archive")

    def fake_psql(sql, capture=False):
        return "1|2026-02-25T10:00:00+00:00|preference|ctx|lesson"

    monkeypatch.setattr(mod, "psql", fake_psql)
    monkeypatch.setattr(mod, "quality_gate", lambda text, enabled, dry: {"verdict": "archive"})

    c = {"e": 0, "s": 0, "p": 0, "v": 0}
    mod.ingest_feedback(run_id=1, since=datetime.now(timezone.utc), c=c, dry=False, use_quality_gate=True)
    assert c == {"e": 0, "s": 0, "p": 0, "v": 0}
