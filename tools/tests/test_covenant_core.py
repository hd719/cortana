import json

import pytest


def test_route_workflow_plan_failure_retry_and_escalate(load_module):
    mod = load_module("covenant/route_workflow.py", "route_workflow")
    retry = mod.plan_failure(
        {
            "failure_type": "network_timeout",
            "agent_identity_id": "agent.huragok.v1",
            "attempt": 1,
            "max_retries": 2,
        }
    )
    assert retry["action"] == "retry_same_agent"
    assert retry["state"] == "in_progress"

    esc = mod.plan_failure(
        {
            "failure_type": "auth_failure",
            "agent_identity_id": "agent.huragok.v1",
            "attempt": 1,
            "max_retries": 2,
        }
    )
    assert esc["action"].startswith("escalate")
    assert esc["state"] == "blocked"


def test_spawn_guard_normalization_and_key(load_module):
    mod = load_module("covenant/spawn_guard.py", "spawn_guard")
    assert mod._norm_label(" Huragok  migration___hygiene ") == "huragok-migration-hygiene"
    assert mod.dedupe_key("Task Label", 42) == "task:42|label:task-label"


def test_validate_agent_protocol_status_and_completion(load_module):
    mod = load_module("covenant/validate_agent_protocol.py", "validate_protocol")
    defs = mod.load_schema_defs()

    status = {
        "request_id": "r1",
        "agent_identity_id": "agent.huragok.v1",
        "state": "in_progress",
        "confidence": 0.7,
        "timestamp": "2026-02-26T10:00:00Z",
    }
    completion = {
        "request_id": "r1",
        "agent_identity_id": "agent.huragok.v1",
        "state": "completed",
        "summary": "done",
        "artifacts": [],
        "risks": [],
        "follow_ups": [],
        "confidence": 0.8,
        "timestamp": "2026-02-26T10:05:00Z",
    }

    mod.validate_status(status, defs)
    mod.validate_completion(completion, defs)


def test_validate_agent_protocol_rejects_extra_field(load_module):
    mod = load_module("covenant/validate_agent_protocol.py", "validate_protocol_bad")
    defs = mod.load_schema_defs()
    bad = {
        "request_id": "r1",
        "agent_identity_id": "agent.huragok.v1",
        "state": "in_progress",
        "confidence": 0.7,
        "timestamp": "2026-02-26T10:00:00Z",
        "extra": True,
    }
    with pytest.raises(mod.ValidationError):
        mod.validate_status(bad, defs)


def test_prepare_spawn_normalize_and_auto_route(monkeypatch, tmp_path, load_module):
    mod = load_module("covenant/prepare_spawn.py", "prepare_spawn")

    raw = {"mission": "Do thing", "expected_outcome": "Done"}
    normalized, notes = mod.normalize_payload(raw, legacy_shim=True)
    assert normalized["objective"] == "Do thing"
    assert normalized["success_criteria"] == ["Done"]
    assert "callback" in normalized
    assert notes

    # auto-route path with mocked subprocess output
    monkeypatch.setattr(mod, "ROUTER", tmp_path / "route_workflow.py")
    mod.ROUTER.write_text("# mock")

    class FakeProc:
        returncode = 0
        stderr = ""
        stdout = "ROUTING_PLAN_JSON: " + json.dumps({"primary_agent_identity_id": "agent.oracle.v1"})

    monkeypatch.setattr(mod.subprocess, "run", lambda *a, **k: FakeProc())
    out, notes2 = mod.maybe_auto_route_identity({"objective": "x"}, auto_route=True)
    assert out["agent_identity_id"] == "agent.oracle.v1"
    assert notes2
