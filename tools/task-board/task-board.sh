#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB="cortana"

usage() {
  cat <<'EOF'
Task Board helper CLI

Usage:
  task-board.sh list
  task-board.sh blocked
  task-board.sh epics
  task-board.sh ready
  task-board.sh due-today
  task-board.sh counts
  task-board.sh summary
  task-board.sh view <id>
  task-board.sh done <id>
  task-board.sh skip <id>
  task-board.sh add "<title>" [priority]
EOF
}

query() {
  psql "$DB" -v ON_ERROR_STOP=1 -P pager=off -c "$1"
}

cmd="${1:-}"
case "$cmd" in
  list)
    query "SELECT id, title, status, priority, due_at, epic_id, auto_executable FROM cortana_tasks WHERE status IN ('pending','in_progress','blocked') ORDER BY priority ASC, created_at ASC LIMIT 50;"
    ;;
  blocked)
    query "SELECT t.id, t.title, t.priority, t.depends_on, e.title AS epic_title FROM cortana_tasks t LEFT JOIN cortana_epics e ON t.epic_id=e.id WHERE t.status != 'done' AND t.depends_on IS NOT NULL AND EXISTS (SELECT 1 FROM cortana_tasks t2 WHERE t2.id = ANY(t.depends_on) AND t2.status != 'done') ORDER BY t.priority ASC;"
    ;;
  epics)
    query "SELECT e.id, e.title, e.deadline, COUNT(t.id) AS total_tasks, COUNT(CASE WHEN t.status='done' THEN 1 END) AS completed_tasks FROM cortana_epics e LEFT JOIN cortana_tasks t ON t.epic_id=e.id WHERE e.status='active' GROUP BY e.id, e.title, e.deadline ORDER BY e.deadline ASC NULLS LAST;"
    ;;
  ready)
    query "SELECT id, title, priority FROM cortana_tasks WHERE status='pending' AND auto_executable=TRUE AND (depends_on IS NULL OR NOT EXISTS (SELECT 1 FROM cortana_tasks t2 WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status != 'done')) ORDER BY priority ASC, created_at ASC;"
    ;;
  due-today)
    query "SELECT id, title, priority, due_at FROM cortana_tasks WHERE status='pending' AND (due_at::date=CURRENT_DATE OR priority=1) ORDER BY priority ASC, due_at ASC NULLS LAST;"
    ;;
  counts)
    query "SELECT 'active' AS metric, COUNT(*) AS count FROM cortana_tasks WHERE status IN ('pending','in_progress','blocked'); SELECT status, COUNT(*) AS count FROM cortana_tasks GROUP BY status ORDER BY CASE status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, status; SELECT priority, COUNT(*) AS count FROM cortana_tasks WHERE status IN ('pending','in_progress','blocked') GROUP BY priority ORDER BY priority ASC;"
    ;;
  summary)
    query "SELECT COUNT(*) AS active_tasks FROM cortana_tasks WHERE status IN ('pending','in_progress','blocked'); SELECT id, title, status, priority, due_at FROM cortana_tasks WHERE status IN ('pending','in_progress','blocked') ORDER BY priority ASC, due_at ASC NULLS LAST, created_at ASC LIMIT 5;"
    ;;
  view)
    id="${2:-}"; [[ -n "$id" ]] || { usage; exit 1; }
    query "SELECT t.*, e.title AS epic_title FROM cortana_tasks t LEFT JOIN cortana_epics e ON e.id=t.epic_id WHERE t.id=$id;"
    ;;
  done)
    id="${2:-}"; [[ -n "$id" ]] || { usage; exit 1; }
    query "UPDATE cortana_tasks SET status='done', completed_at=NOW() WHERE id=$id; SELECT id, title, status, completed_at FROM cortana_tasks WHERE id=$id;"
    ;;
  skip)
    id="${2:-}"; [[ -n "$id" ]] || { usage; exit 1; }
    query "UPDATE cortana_tasks SET status='cancelled' WHERE id=$id; SELECT id, title, status FROM cortana_tasks WHERE id=$id;"
    ;;
  add)
    title="${2:-}"; [[ -n "$title" ]] || { usage; exit 1; }
    priority="${3:-3}"
    esc_title=${title//\'/\'\'}
    query "INSERT INTO cortana_tasks (title, priority, auto_executable, source, status) VALUES ('$esc_title', $priority, FALSE, 'conversation', 'pending'); SELECT currval(pg_get_serial_sequence('cortana_tasks','id')) AS created_task_id;"
    ;;
  *)
    usage
    exit 1
    ;;
esac
