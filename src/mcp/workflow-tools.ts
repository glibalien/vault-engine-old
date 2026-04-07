import type Database from 'better-sqlite3';
import { buildLookupMaps, resolveTargetWithMaps } from '../sync/resolver.js';
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
  recent_activity: Array<{ id: string; title: string; indexed_at: string }>;
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

  // Recent activity: tasks ordered by indexed_at DESC
  const placeholders = taskIds.map(() => '?').join(', ');
  const recentRows = db.prepare(`
    SELECT id, title, indexed_at FROM nodes
    WHERE id IN (${placeholders})
    ORDER BY indexed_at DESC
    LIMIT 10
  `).all(...taskIds) as Array<{ id: string; title: string | null; indexed_at: string }>;

  const recentActivity = recentRows.map(r => ({
    id: r.id,
    title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
    indexed_at: r.indexed_at,
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

/**
 * Get the end of the ISO week (Sunday) for a given date.
 * ISO weeks start Monday. Sunday = day 7.
 */
function endOfIsoWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

interface DueDateTask {
  id: string;
  title: string;
  types: string[];
  due_date: string;
  status: string;
  assignee: string | null;
}

function queryDueTasks(db: Database.Database): DueDateTask[] {
  const rows = db.prepare(`
    SELECT n.id, n.title,
      SUBSTR(fd.value_date, 1, 10) AS due_date,
      fs.value_text AS status,
      fa.value_text AS assignee
    FROM nodes n
    JOIN fields fd ON fd.node_id = n.id AND fd.key = 'due_date'
    LEFT JOIN fields fs ON fs.node_id = n.id AND fs.key = 'status'
    LEFT JOIN fields fa ON fa.node_id = n.id AND fa.key = 'assignee'
    WHERE fd.value_date IS NOT NULL
  `).all() as Array<{
    id: string; title: string | null;
    due_date: string; status: string | null; assignee: string | null;
  }>;

  const nodeIds = rows.map(r => r.id);
  const typeRows = nodeIds.length > 0
    ? db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`)
        .all(...nodeIds) as Array<{ node_id: string; schema_type: string }>
    : [];
  const typeMap = new Map<string, string[]>();
  for (const r of typeRows) {
    const arr = typeMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    typeMap.set(r.node_id, arr);
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
    types: typeMap.get(r.id) ?? [],
    due_date: r.due_date,
    status: r.status ?? 'unknown',
    assignee: r.assignee ?? null,
  }));
}

export function dailySummaryHandler(
  db: Database.Database,
  params: { date?: string },
) {
  const today = params.date ?? new Date().toISOString().slice(0, 10);
  const weekEnd = endOfIsoWeek(today);

  const allDueTasks = queryDueTasks(db);
  const isActive = (t: DueDateTask) => t.status !== 'done' && t.status !== 'cancelled';

  const overdue = allDueTasks.filter(t => t.due_date < today && isActive(t));
  const dueToday = allDueTasks.filter(t => t.due_date === today && isActive(t));
  const dueThisWeek = allDueTasks.filter(t =>
    t.due_date > today && t.due_date <= weekEnd && isActive(t)
  );

  // Recently modified: typed nodes only, limit 20
  const recentlyModified = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.indexed_at
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id
    ORDER BY n.indexed_at DESC
    LIMIT 20
  `).all() as Array<{ id: string; title: string | null; indexed_at: string }>;

  // Load types for recently modified
  const recentIds = recentlyModified.map(r => r.id);
  const recentTypeRows = recentIds.length > 0
    ? db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${recentIds.map(() => '?').join(',')})`)
        .all(...recentIds) as Array<{ node_id: string; schema_type: string }>
    : [];
  const recentTypeMap = new Map<string, string[]>();
  for (const r of recentTypeRows) {
    const arr = recentTypeMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    recentTypeMap.set(r.node_id, arr);
  }

  // Active projects: status = 'active' OR no status field
  const activeProjects = db.prepare(`
    SELECT DISTINCT n.id, n.title
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = 'project'
    LEFT JOIN fields fs ON fs.node_id = n.id AND fs.key = 'status'
    WHERE fs.value_text = 'active' OR fs.value_text IS NULL
  `).all() as Array<{ id: string; title: string | null }>;

  const activeProjectStats = activeProjects.map(p => {
    const stats = computeProjectTaskStats(db, p.id, today);
    return {
      id: p.id,
      title: p.title ?? p.id.replace(/\.md$/, '').split('/').pop()!,
      status: 'active',
      total_tasks: stats.total_tasks,
      completed_tasks: stats.completed_tasks,
      completion_pct: stats.completion_pct,
    };
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        date: today,
        overdue,
        due_today: dueToday,
        due_this_week: dueThisWeek,
        recently_modified: recentlyModified.map(r => ({
          id: r.id,
          title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
          types: recentTypeMap.get(r.id) ?? [],
          indexed_at: r.indexed_at,
        })),
        active_projects: activeProjectStats,
      }),
    }],
  };
}

interface MeetingNotesParams {
  title: string;
  date: string;
  attendees: string[];
  project?: string;
  agenda?: string;
  body?: string;
}

type BatchOp = { op: 'create' | 'update' | 'delete' | 'link' | 'unlink'; params: Record<string, unknown> };
type BatchMutateFn = (params: { operations: BatchOp[] }) => any;

export function createMeetingNotesHandler(
  db: Database.Database,
  batchMutate: BatchMutateFn,
  params: MeetingNotesParams,
) {
  const { title, date, attendees, project, agenda, body } = params;

  // Batch-resolve attendees
  const { titleMap, pathMap } = buildLookupMaps(db);
  const resolvedAttendees: string[] = [];
  const createdAttendees: string[] = [];

  const operations: BatchOp[] = [];

  for (const name of attendees) {
    const nodeId = resolveTargetWithMaps(name, titleMap, pathMap);
    if (nodeId) {
      resolvedAttendees.push(name);
    } else {
      createdAttendees.push(name);
      operations.push({
        op: 'create',
        params: { title: name, types: ['person'] },
      });
    }
  }

  // Build attendees wiki-link list
  const attendeeLinks = attendees.map(name => `[[${name}]]`);

  // Build meeting fields
  const meetingFields: Record<string, unknown> = {
    date,
    attendees: attendeeLinks,
  };
  if (project) {
    meetingFields.project = `[[${project.replace(/^\[\[/, '').replace(/\]\]$/, '')}]]`;
  }

  // Build meeting body
  let meetingBody = '';
  if (agenda) meetingBody += agenda;
  if (body) meetingBody += (meetingBody ? '\n\n' : '') + body;

  operations.push({
    op: 'create',
    params: {
      title,
      types: ['meeting'],
      fields: meetingFields,
      ...(meetingBody ? { body: meetingBody } : {}),
    },
  });

  const result = batchMutate({ operations });

  // Check for error
  const parsed = JSON.parse(result.content[0].text);
  if (result.isError || parsed.error) {
    return result;
  }

  // Extract meeting node from results (last create op)
  const meetingResult = parsed.results[parsed.results.length - 1];

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        node: meetingResult.node,
        warnings: parsed.warnings,
        resolved_attendees: resolvedAttendees,
        created_attendees: createdAttendees,
      }),
    }],
  };
}

interface TaskInput {
  title: string;
  assignee?: string;
  due_date?: string;
  priority?: string;
  status?: string;
  fields?: Record<string, unknown>;
}

interface ExtractTasksParams {
  source_node_id: string;
  tasks: TaskInput[];
}

export function extractTasksHandler(
  db: Database.Database,
  batchMutate: BatchMutateFn,
  params: ExtractTasksParams,
) {
  const { source_node_id, tasks } = params;

  // Validate source exists
  const sourceNode = db.prepare('SELECT id, title FROM nodes WHERE id = ?')
    .get(source_node_id) as { id: string; title: string | null } | undefined;
  if (!sourceNode) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: `Source node not found: ${source_node_id}`, code: 'NOT_FOUND' }) }],
      isError: true,
    };
  }

  const sourceTitle = sourceNode.title ?? source_node_id.replace(/\.md$/, '').split('/').pop()!;

  const operations: BatchOp[] = tasks.map(task => {
    const fields: Record<string, unknown> = {
      ...task.fields,
      source: `[[${sourceTitle}]]`,
      status: task.status ?? 'todo',
    };
    if (task.assignee) fields.assignee = task.assignee;
    if (task.due_date) fields.due_date = task.due_date;
    if (task.priority) fields.priority = task.priority;

    return {
      op: 'create' as const,
      params: {
        title: task.title,
        types: ['task'],
        fields,
      },
    };
  });

  const result = batchMutate({ operations });
  const parsed = JSON.parse(result.content[0].text);

  if (result.isError || parsed.error) {
    return result;
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        tasks: parsed.results,
        warnings: parsed.warnings,
      }),
    }],
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
    'SELECT id, file_path, node_type, title, content_text, content_md, indexed_at FROM nodes WHERE id = ?'
  ).get(project_id);
  if (!projectRow) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: `Node not found: ${project_id}`, code: 'NOT_FOUND' }) }],
      isError: true,
    };
  }

  const [project] = hydrateNodes([projectRow as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; indexed_at: string }]);
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
