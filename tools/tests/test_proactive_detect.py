from datetime import datetime


def test_signal_fingerprint_normalized(load_module):
    mod = load_module("proactive/detect.py", "proactive_detect")
    s = mod.Signal(source="email", signal_type="x", title="  Hello   World ", summary="", confidence=0.8)
    fp = s.fingerprint()
    assert "hello world" in fp


def test_tokenize_filters_stopwords(load_module):
    mod = load_module("proactive/detect.py", "proactive_detect_tok")
    toks = mod.tokenize("The meeting and project update for team")
    assert "meeting" not in toks
    assert "project" not in toks
    assert "team" not in toks


def test_correlate_requires_overlap_threshold(load_module):
    mod = load_module("proactive/detect.py", "proactive_detect_corr")
    sigs = [
        mod.Signal(source="calendar", signal_type="a", title="Client security review", summary="Prepare threat model", confidence=0.7),
        mod.Signal(source="email", signal_type="b", title="Security review follow up", summary="Client asked for prep", confidence=0.7),
    ]
    out = mod.correlate(sigs)
    assert len(out) == 1
    assert out[0].signal_type == "calendar_email_correlation"
    assert out[0].confidence >= 0.68


def test_persist_applies_min_confidence_and_task_threshold(monkeypatch, load_module):
    mod = load_module("proactive/detect.py", "proactive_detect_persist")
    calls = []

    def fake_run_psql(sql):
        calls.append(sql)
        if "INSERT INTO cortana_proactive_signals" in sql:
            return "101"
        return ""

    monkeypatch.setattr(mod, "run_psql", fake_run_psql)

    signals = [
        mod.Signal(source="email", signal_type="low", title="Low", summary="", confidence=0.5),
        mod.Signal(source="email", signal_type="hi", title="High", summary="", confidence=0.9),
    ]
    inserted, suggested = mod.persist(run_id=1, signals=signals, min_conf=0.66, create_tasks=True)
    assert inserted == 1
    assert suggested == 1
    assert any("INSERT INTO cortana_tasks" in c for c in calls)
