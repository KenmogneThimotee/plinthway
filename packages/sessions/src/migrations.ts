export const INITIAL_MIGRATION = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES sessions(id),
  branch_from_sequence INTEGER,
  profile_id TEXT NOT NULL,
  profile_generation_id TEXT NOT NULL,
  profile_snapshot_json TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  model_override TEXT,
  status TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, sequence)
) STRICT;
CREATE TABLE active_profile (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  profile_id TEXT NOT NULL,
  profile_generation_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE selected_profile (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  profile_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE profile_transitions (
  id TEXT PRIMARY KEY,
  previous_profile_id TEXT,
  target_profile_id TEXT NOT NULL,
  previous_snapshot_json TEXT,
  target_snapshot_json TEXT NOT NULL,
  state TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX session_events_type_idx ON session_events(session_id, type, sequence);
CREATE INDEX sessions_updated_idx ON sessions(updated_at DESC, id);
`;

export const MCP_TASKS_MIGRATION = `
CREATE TABLE mcp_tasks (
  server_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  profile_generation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  task_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(server_id, task_id)
) STRICT;
CREATE INDEX mcp_tasks_profile_status_idx
  ON mcp_tasks(profile_generation_id, status, updated_at DESC);
`;

export const MCP_TASK_OUTCOMES_MIGRATION = `
ALTER TABLE mcp_tasks ADD COLUMN result_json TEXT;
ALTER TABLE mcp_tasks ADD COLUMN error_json TEXT;
`;

export const MCP_TASK_PROFILE_ISOLATION_MIGRATION = `
CREATE TABLE mcp_tasks_v4 (
  server_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  profile_generation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  task_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  result_json TEXT,
  error_json TEXT,
  PRIMARY KEY(profile_generation_id, server_id, task_id)
) STRICT;
INSERT INTO mcp_tasks_v4 SELECT * FROM mcp_tasks;
DROP TABLE mcp_tasks;
ALTER TABLE mcp_tasks_v4 RENAME TO mcp_tasks;
CREATE INDEX mcp_tasks_profile_status_idx
  ON mcp_tasks(profile_generation_id, status, updated_at DESC);
`;

export const SELECTED_PROFILE_MIGRATION = `
CREATE TABLE IF NOT EXISTS selected_profile (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  profile_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;
