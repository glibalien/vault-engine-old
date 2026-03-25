import type Database from 'better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HydrateNodes = (rows: any[], opts?: any) => any[];

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  due_date: string | null;
  priority: string | null;
}

export interface ProjectTaskStats {
  total_tasks: number;
  completed_tasks: number;
  completion_pct: number;
  tasks_by_status: Record<string, TaskSummary[]>;
  overdue_tasks: TaskSummary[];
  recent_activity: Array<{ id: string; title: string; updated_at: string }>;
}

/**
 * Find all task node IDs that reference a given project via any relationship.
 */
function findProjectTaskIds(db: Database.Database, projectId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT r.source_id
    FROM relationships r
    JOIN node_types nt ON nt.node_id = r.source_id AND nt.schema_type = 'task'
    WHERE r.resolved_target_id = ?
  `).all(projectId) as Array<{ source_id: string }>;
  return rows.map(r => r.source_id);
}

function getTaskField(db: Database.Database, nodeId: string, key: string): string | null {
  const row = db.prepare('SELECT value_text, value_type, value_date FROM fields WHERE node_id = ? AND key = ?')
    .get(nodeId, key) as { value_text: string; value_type: string; value_date: string | null } | undefined;
  if (!row) return null;
  // Normalize dates to YYYY-MM-DD (value_date stores full ISO like "2026-03-20T00:00:00.000Z")
  if (row.value_type === 'date' && row.value_date) return row.value_date.slice(0, 10);
  return row.value_text;
}

export function computeProjectTaskStats(
  db: Database.Database,
  projectId: string,
  today?: string,
): ProjectTaskStats {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const taskIds = findProjectTaskIds(db, projectId);

  if (taskIds.length === 0) {
    return {
      total_tasks: 0,
      completed_tasks: 0,
      completion_pct: 0,
      tasks_by_status: {},
      overdue_tasks: [],
      recent_activity: [],
    };
  }

  const tasks: TaskSummary[] = [];
  for (const id of taskIds) {
    const node = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(id) as
      { id: string; title: string | null } | undefined;
    if (!node) continue;
    tasks.push({
      id: node.id,
      title: node.title ?? id.replace(/\.md$/, '').split('/').pop()!,
      status: getTaskField(db, id, 'status') ?? 'unknown',
      assignee: getTaskField(db, id, 'assignee'),
      due_date: getTaskField(db, id, 'due_date'),
      priority: getTaskField(db, id, 'priority'),
    });
  }

  const tasksByStatus: Record<string, TaskSummary[]> = {};
  for (const task of tasks) {
    const bucket = tasksByStatus[task.status] ?? [];
    bucket.push(task);
    tasksByStatus[task.status] = bucket;
  }

  const completedTasks = tasks.filter(t => t.status === 'done').length;
  const completionPct = tasks.length > 0
    ? Math.round((completedTasks / tasks.length) * 10000) / 100
    : 0;

  const overdueTasks = tasks.filter(t =>
    t.due_date && t.due_date < todayStr &&
    t.status !== 'done' && t.status !== 'cancelled'
  );

  // Recent activity: tasks ordered by updated_at DESC
  const placeholders = taskIds.map(() => '?').join(', ');
  const recentRows = db.prepare(`
    SELECT id, title, updated_at FROM nodes
    WHERE id IN (${placeholders})
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(...taskIds) as Array<{ id: string; title: string | null; updated_at: string }>;

  const recentActivity = recentRows.map(r => ({
    id: r.id,
    title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
    updated_at: r.updated_at,
  }));

  return {
    total_tasks: tasks.length,
    completed_tasks: completedTasks,
    completion_pct: completionPct,
    tasks_by_status: tasksByStatus,
    overdue_tasks: overdueTasks,
    recent_activity: recentActivity,
  };
}

export function projectStatusHandler(
  db: Database.Database,
  hydrateNodes: HydrateNodes,
  params: { project_id: string },
) {
  const { project_id } = params;

  // Verify project exists
  const projectRow = db.prepare(
    'SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id = ?'
  ).get(project_id);
  if (!projectRow) {
    return { content: [{ type: 'text' as const, text: `Error: Node not found: ${project_id}` }], isError: true };
  }

  const [project] = hydrateNodes([projectRow as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string }]);
  const stats = computeProjectTaskStats(db, project_id);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        project,
        ...stats,
      }),
    }],
  };
}
