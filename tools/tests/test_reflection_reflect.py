

def test_classify_task_failure_and_success(load_module):
    mod = load_module("reflection/reflect.py", "reflection_reflect")
    t_fail = {"title": "X", "description": "", "outcome": "failed due to error", "status": "done"}
    t_ok = {"title": "X", "description": "", "outcome": "all good", "status": "done"}

    fail = mod._classify_task(t_fail)
    ok = mod._classify_task(t_ok)

    assert fail[0] == "failure"
    assert ok[0] == "success"


def test_extract_rules_scores_and_repeat_rate(monkeypatch, load_module):
    mod = load_module("reflection/reflect.py", "reflection_reflect_extract")
    rows = [
        {"feedback_type": "preference", "lesson": "Do X", "evidence_count": 3, "first_seen": "2026-02-20", "last_seen": "2026-02-26"},
        {"feedback_type": "fact", "lesson": "Fact Y", "evidence_count": 1, "first_seen": "2026-02-21", "last_seen": "2026-02-25"},
    ]
    monkeypatch.setattr(mod, "_fetch_json", lambda sql: rows)
    rules, repeated_rate, total = mod._extract_rules(window_days=30)
    assert len(rules) == 2
    assert total == 4
    assert repeated_rate == 50.0
    assert rules[0].confidence >= rules[1].confidence


def test_upsert_rules_applies_when_threshold_met(monkeypatch, load_module):
    mod = load_module("reflection/reflect.py", "reflection_reflect_upsert")
    applied = []
    updates = []

    monkeypatch.setattr(mod, "_apply_rule_to_file", lambda path, rule: applied.append((str(path), rule.rule_text)))
    monkeypatch.setattr(mod, "_run_psql", lambda sql: updates.append(sql) or "")

    rule = mod.ReflectionRule(
        feedback_type="preference",
        rule_text="Keep updates concise",
        evidence_count=2,
        first_seen="2026-02-20",
        last_seen="2026-02-26",
        confidence=0.9,
    )
    n = mod._upsert_rules(run_id=1, rules=[rule], auto_threshold=0.82)
    assert n == 1
    assert applied
    assert any("status='applied'" in q for q in updates)
