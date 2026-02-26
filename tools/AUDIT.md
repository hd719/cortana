# Tools Script Audit

Generated: 2026-02-26

| script path | syntax OK? | referenced by | verdict |
|---|---|---|---|
| `tools/alerting/cron-preflight.sh` | yes | HEARTBEAT.md; other: sae/brief-2.0-template.md | keep |
| `tools/alerting/tonal-health-check.sh` | yes | other: tools/alerting/dependencies.json | keep |
| `tools/behavioral-twin/predict` | n/a | other: tools/covenant/planner.py, tools/fitness/specialist-prompts.md, learning/football/04-strategy-analysis.md, covenant/CORTANA.md … | keep |
| `tools/behavioral-twin/predict.py` | yes | none found | keep |
| `tools/briefing/decision_queue.py` | yes | none found | keep |
| `tools/browser-recovery/restore-tabs.sh` | yes | other: tools/browser-recovery/README.md | keep |
| `tools/calendar/reminders.py` | yes | none found | keep |
| `tools/career/opportunity_engine.py` | yes | none found | keep |
| `tools/chaos/__init__.py` | yes | none found | keep |
| `tools/chaos/mttr.py` | yes | other: docs/chaos-suite-design.md | keep |
| `tools/chaos/resilience_harness.py` | yes | none found | keep |
| `tools/chaos/runner.py` | yes | other: docs/chaos-suite-design.md | keep |
| `tools/chaos/scenarios/__init__.py` | yes | none found | keep |
| `tools/chaos/scenarios/base.py` | yes | none found | keep |
| `tools/chaos/scenarios/cron_failure.py` | yes | none found | keep |
| `tools/chaos/scenarios/db_connection_issue.py` | yes | none found | keep |
| `tools/chaos/scenarios/heartbeat_miss.py` | yes | none found | keep |
| `tools/chaos/scenarios/memory_corruption.py` | yes | none found | keep |
| `tools/chaos/scenarios/tool_unavailability.py` | yes | none found | keep |
| `tools/conftest.py` | yes | none found | keep |
| `tools/covenant/artifact_bus.py` | yes | other: docs/correlation-tracing.md, docs/handoff-artifact-bus.md | keep |
| `tools/covenant/build_identity_spawn_prompt.py` | yes | other: tools/covenant/prepare_spawn.py, tools/covenant/examples/completion.valid.json, agents/identities/CONTRACT.md, docs/identity-scoped-memory.md … | keep |
| `tools/covenant/checkpoint.py` | yes | other: docs/workflow-checkpointing.md | keep |
| `tools/covenant/critic.py` | yes | other: docs/covenant-integration-strategy.md, docs/inter-agent-communication-gaps.md, docs/covenant-orchestration-v2.md | keep |
| `tools/covenant/executor.py` | yes | other: docs/covenant-integration-strategy.md, docs/inter-agent-communication-gaps.md, docs/parallel-executor.md, docs/covenant-orchestration-v2.md | keep |
| `tools/covenant/fan_in.py` | yes | other: docs/parallel-executor.md | keep |
| `tools/covenant/feedback_compiler.py` | yes | other: tools/covenant/build_identity_spawn_prompt.py, docs/identity-scoped-memory.md, docs/agent-feedback-compiler.md | keep |
| `tools/covenant/lifecycle_events.py` | yes | other: tools/covenant/spawn_guard.py, docs/agent-lifecycle-events.md, docs/correlation-tracing.md | keep |
| `tools/covenant/memory_injector.py` | yes | other: tools/covenant/build_identity_spawn_prompt.py, docs/identity-scoped-memory.md, docs/memory-decay-supersession.md | keep |
| `tools/covenant/migration_hygiene.py` | yes | other: docs/migration-hygiene.md | keep |
| `tools/covenant/planner.py` | yes | other: docs/covenant-integration-strategy.md, docs/inter-agent-communication-gaps.md, docs/parallel-executor.md, docs/covenant-orchestration-v2.md | keep |
| `tools/covenant/prepare_spawn.py` | yes | other: agents/identities/CONTRACT.md, covenant/CORTANA.md, covenant/README.md, docs/covenant-operational-routing-task15.md … | keep |
| `tools/covenant/quality_scorecard.py` | yes | other: docs/agent-quality-scorecards.md | keep |
| `tools/covenant/route_workflow.py` | yes | other: tools/tests/test_covenant_core.py, tools/covenant/prepare_spawn.py, covenant/CORTANA.md, covenant/README.md … | keep |
| `tools/covenant/spawn_guard.py` | yes | other: docs/spawn-dedupe-guard.md | keep |
| `tools/covenant/tests_parallel_executor.py` | yes | other: docs/parallel-executor.md | keep |
| `tools/covenant/trace.py` | yes | other: tools/covenant/lifecycle_events.py, tools/covenant/artifact_bus.py, docs/correlation-tracing.md | keep |
| `tools/covenant/validate_agent_protocol.py` | yes | other: tools/covenant/build_identity_spawn_prompt.py, tools/covenant/examples/completion.invalid.json, tools/covenant/examples/status.valid.json, tools/covenant/examples/completion.valid.json … | keep |
| `tools/covenant/validate_memory_boundary.py` | yes | other: agents/identities/CONTRACT.md, covenant/CORTANA.md, docs/inter-agent-communication-gaps.md | keep |
| `tools/covenant/validate_spawn_handshake.py` | yes | other: tools/covenant/build_identity_spawn_prompt.py, tools/covenant/prepare_spawn.py, docs/covenant-identity-v1-migration-checklist.md, docs/correlation-tracing.md | keep |
| `tools/earnings/check-earnings.sh` | yes | cron/jobs.json; other: tools/earnings/README.md | keep |
| `tools/earnings/create-calendar-events.sh` | yes | cron/jobs.json; other: tools/earnings/README.md | keep |
| `tools/earnings-alert/earnings-check.py` | yes | other: tools/earnings-alert/README.md | keep |
| `tools/earnings-alert/earnings-check.sh` | yes | cron/jobs.json; other: tools/earnings-alert/README.md | keep |
| `tools/economics/token_ledger.py` | yes | other: docs/token-economics.md | keep |
| `tools/email/inbox_to_execution.py` | yes | other: tools/gmail/email-triage-autopilot.sh | keep |
| `tools/embeddings/embed` | n/a | other: tools/embeddings/embed.py, tools/memory/promote_insights.py, tools/memory/extract_facts.py, tools/reflection/feedback_verifier.py … | keep |
| `tools/embeddings/embed.py` | yes | other: tools/memory/promote_insights.py, tools/memory/extract_facts.py, tools/reflection/feedback_verifier.py, docs/local-embeddings.md … | keep |
| `tools/event-bus/listener.py` | yes | other: docs/event-bus.md | keep |
| `tools/event-bus/publish.py` | yes | other: docs/event-bus.md | keep |
| `tools/failsafe/local-inference.py` | yes | other: docs/local-inference-failsafe.md | keep |
| `tools/fitness/morning-brief-data.sh` | yes | cron/jobs.json; other: memory/cron-optimization-feb26.md | keep |
| `tools/gmail/email-triage-autopilot.sh` | yes | HEARTBEAT.md | keep |
| `tools/governor/risk_score.py` | yes | other: tools/task-board/auto-executor.sh, docs/autonomy-governor.md | keep |
| `tools/guardrails/approval-gate.py` | yes | none found | keep |
| `tools/guardrails/approval-gate.sh` | yes | none found | remove |
| `tools/guardrails/circuit-breaker.py` | yes | none found | keep |
| `tools/guardrails/exec-guard.sh` | yes | other: tools/guardrails/README.md | keep |
| `tools/guardrails/tone_drift_sentinel.py` | yes | none found | keep |
| `tools/health/adaptive_sleep.py` | yes | none found | keep |
| `tools/homeassistant/ha.mjs` | n/a | none found | keep |
| `tools/hygiene/sweep.py` | yes | other: docs/system-hygiene-sweep.md | keep |
| `tools/immune_scan.sh` | yes | other: tools/chaos/resilience_harness.py | keep |
| `tools/log-decision.sh` | yes | other: tools/log-heartbeat-decision.sh, tools/README.md, tools/tracing/heartbeat-integration-examples.md | keep |
| `tools/log-heartbeat-decision.sh` | yes | other: tools/tracing/heartbeat-integration-examples.md | keep |
| `tools/market-intel/bird-healthcheck.sh` | yes | cron/jobs.json | keep |
| `tools/market-intel/market-intel.py` | yes | other: tools/market-intel/README.md | keep |
| `tools/market-intel/market-intel.sh` | yes | HEARTBEAT.md; other: TOOLS.md, tools/market-intel/README.md | keep |
| `tools/memory/compress.py` | yes | other: docs/memory-compression.md | keep |
| `tools/memory/decay-scorer.py` | yes | none found | keep |
| `tools/memory/decay.py` | yes | other: docs/memory-decay-supersession.md | keep |
| `tools/memory/extract-from-sessions.py` | yes | none found | keep |
| `tools/memory/extract_facts.py` | yes | other: docs/atomic-fact-extraction.md | keep |
| `tools/memory/ingest_unified_memory.py` | yes | HEARTBEAT.md; other: tools/memory/README.md, docs/memory-engine-design.md | keep |
| `tools/memory/markdown-sync.py` | yes | none found | keep |
| `tools/memory/memory_quality_gate.py` | yes | other: tools/memory/ingest_unified_memory.py | keep |
| `tools/memory/predictive-context.sh` | yes | other: tools/morning-brief/enrich.sh | keep |
| `tools/memory/promote_insights.py` | yes | other: docs/conversation-insight-promotion.md | keep |
| `tools/memory/supersession.py` | yes | other: docs/memory-decay-supersession.md | keep |
| `tools/mission-control/deploy.sh` | yes | other: tools/mission-control/README.md | keep |
| `tools/monitoring/anomaly_sentinel.py` | yes | other: docs/anomaly-sentinel.md | keep |
| `tools/monitoring/proprioception-metrics.sh` | yes | cron/jobs.json; other: memory/cron-optimization-feb26.md | keep |
| `tools/morning-brief/enrich.sh` | yes | none found | remove |
| `tools/mortgage/mortgage_intel.py` | yes | none found | keep |
| `tools/ops-eye/capture` | n/a | cron/jobs.json; other: README.md, tools/career/opportunity_engine.py, tools/tracing/vector-memory-coverage.md, tools/memory/ingest_unified_memory.py … | keep |
| `tools/ops-eye/capture.py` | yes | other: docs/multimodal-ops-eye.md | keep |
| `tools/oracle/precompute.py` | yes | other: docs/precompute-oracle.md | keep |
| `tools/policy/engine.py` | yes | other: docs/autonomy-policy-engine.md | keep |
| `tools/proactive/detect.py` | yes | HEARTBEAT.md; other: docs/proactive-detector-design.md | keep |
| `tools/proactive/evaluate_accuracy.py` | yes | other: reports/proactive-signal-audit.json | keep |
| `tools/proactive/pattern-analyzer.py` | yes | none found | keep |
| `tools/proactive/risk_radar.py` | yes | other: tools/briefing/decision_queue.py | keep |
| `tools/proactive/signal_calibrator.py` | yes | other: docs/proactive-signal-calibration.md | keep |
| `tools/reflection/correction-strengthener.py` | yes | none found | keep |
| `tools/reflection/feedback_verifier.py` | yes | other: docs/feedback-closure-verifier.md | keep |
| `tools/reflection/recurrence_radar.py` | yes | none found | keep |
| `tools/reflection/reflect.py` | yes | HEARTBEAT.md; other: docs/learning-loop.md, docs/reflection-loop-design.md, cortical-loop/learning-loop.sh | keep |
| `tools/resilience/drillbook.sh` | yes | other: docs/resilience-drillbook.md | keep |
| `tools/sae/cross-domain-snapshot.sh` | yes | cron/jobs.json; other: memory/cron-optimization-feb26.md | keep |
| `tools/self-upgrade/capability_marketplace.py` | yes | none found | keep |
| `tools/task-board/auto-executor.sh` | yes | HEARTBEAT.md; other: docs/autonomy-governor.md | keep |
| `tools/task-board/auto_sync_enforcer.py` | yes | none found | keep |
| `tools/task-board/dedup-check.sh` | yes | none found | remove |
| `tools/task-board/state-enforcer.sh` | yes | other: tools/task-board/README.md | keep |
| `tools/task-board/state_integrity.py` | yes | none found | keep |
| `tools/task-board/task-board.sh` | yes | none found | remove |
| `tools/tests/test_covenant_core.py` | yes | none found | keep |
| `tools/tests/test_memory_ingest_unified_memory.py` | yes | none found | keep |
| `tools/tests/test_proactive_detect.py` | yes | none found | keep |
| `tools/tests/test_reflection_reflect.py` | yes | none found | keep |
| `tools/tracing/log_decision.py` | yes | none found | keep |
| `tools/trade-alerts/alert.sh` | yes | none found | remove |
| `tools/trading/trade_guardrails.py` | yes | none found | keep |

## Actions Taken (2026-02-26)
- Removed: approval-gate.sh, enrich.sh, dedup-check.sh, task-board.sh, alert.sh (confirmed unused)
