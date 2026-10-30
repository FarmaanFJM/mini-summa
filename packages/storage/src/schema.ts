import type { Migration } from './migrations.ts';

// Schema version 1. This file is the contract between every service that touches the database: services own their
// SQL, but they all agree on these tables. Timestamps are ISO-8601 UTC strings. JSON columns end in _json.
// Booleans are 0/1 integers. Enumerations are enforced with CHECK constraints so a bug fails loudly.

const V1 = `
-- Small key/value store: 'settings' (full Settings JSON), 'instance' (instance id), anything else a service needs.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------------------------
-- Projects, roots, ChatGPT conversations
CREATE TABLE projects (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  description               TEXT,
  github_repo               TEXT,
  default_env               TEXT NOT NULL,
  preferred_conversation_id TEXT,
  default_session_key       TEXT,
  notification_prefs_json   TEXT NOT NULL,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  archived_at               TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE TABLE project_roots (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env        TEXT NOT NULL,
  path       TEXT NOT NULL,
  label      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  root_key   TEXT NOT NULL,                 -- canonical spelling, see rootKey() in @minisumma/shared
  UNIQUE (project_id, root_key)
);
CREATE INDEX project_roots_key ON project_roots(root_key);

CREATE TABLE conversations (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  url                     TEXT NOT NULL,    -- normalized, see parseChatGptUrl()
  original_url            TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('chat','project_chat','gpt_chat','project','other')),
  chatgpt_conversation_id TEXT,
  verification            TEXT NOT NULL DEFAULT 'unverified'
                          CHECK (verification IN ('unverified','verified','mismatch','unreachable','login_required')),
  verified_at             TEXT,
  verified_title          TEXT,
  note                    TEXT,
  position                INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (project_id, url)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Sessions. The reducer rebuilds live state from raw_events; these tables hold what must survive pruning/restarts.

-- Which project (and optionally which conversation) a session belongs to. 'managed' = chosen by Mini-Summa when it
-- started the PTY; 'manual' = chosen by the user for an external session. Precedence: managed, manual, cwd match.
CREATE TABLE session_bindings (
  session_key     TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source          TEXT NOT NULL CHECK (source IN ('managed','manual')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Sessions that Mini-Summa started in its own terminal. The record outlives the app; the PTY does not.
CREATE TABLE managed_sessions (
  session_key     TEXT PRIMARY KEY,
  env             TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  root_id         TEXT,
  cwd             TEXT NOT NULL,
  name            TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('new','resume')),
  resumed_from    TEXT,
  remote_control  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('running','exited','disconnected')),
  pid             INTEGER,
  started_at      TEXT NOT NULL,
  exited_at       TEXT,
  exit_code       INTEGER,
  exit_signal     INTEGER,
  exit_reason     TEXT,
  cols            INTEGER NOT NULL DEFAULT 120,
  rows            INTEGER NOT NULL DEFAULT 32,
  prompted        INTEGER NOT NULL DEFAULT 0,   -- 1 once a prompt was submitted, i.e. the transcript exists and resume works
  last_output_at  TEXT,
  app_run_id      TEXT NOT NULL,                -- which run of the app started it; a different run means the PTY is gone
  argv_json       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX managed_sessions_project ON managed_sessions(project_id);

-- Append-only log of hook and discovery entries. Reducer state is a pure function of this log.
CREATE TABLE raw_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  transport_id TEXT UNIQUE,                     -- one hook invocation; NULL for discovery entries
  kind         TEXT NOT NULL CHECK (kind IN ('hook','discovery','discovery_error')),
  env_id       TEXT,
  ingested_at  TEXT NOT NULL,
  entry_json   TEXT NOT NULL
);
CREATE INDEX raw_events_ingested ON raw_events(ingested_at);

-- Last known view of every session, so history survives raw-log pruning and a restart shows something immediately.
CREATE TABLE sessions_projection (
  session_key      TEXT PRIMARY KEY,
  env              TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  project_id       TEXT,
  origin           TEXT NOT NULL,
  availability     TEXT NOT NULL,
  state            TEXT NOT NULL,
  last_activity_at TEXT,
  view_json        TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX sessions_projection_project ON sessions_projection(project_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Reports and candidates (final messages), full text stored once, untouched.
CREATE TABLE reports (
  id               TEXT PRIMARY KEY,             -- deterministic from (task, body hash): replays cannot duplicate
  session_key      TEXT NOT NULL,
  env              TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_name     TEXT,
  prompt_id        TEXT,
  task_id          TEXT NOT NULL,
  task_title       TEXT NOT NULL,
  declared_status  TEXT NOT NULL CHECK (declared_status IN ('complete','partial','blocked')),
  source           TEXT NOT NULL CHECK (source IN ('marker','user_promoted')),
  body             TEXT NOT NULL,
  body_sha256      TEXT NOT NULL,
  cwd              TEXT,
  late             INTEGER NOT NULL DEFAULT 0,
  stop_hook_active INTEGER NOT NULL DEFAULT 0,
  captured_seq     INTEGER,
  note             TEXT NOT NULL,
  captured_at      TEXT NOT NULL,
  read_at          TEXT,
  redactions       INTEGER NOT NULL DEFAULT 0,
  truncations      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reports_project_time ON reports(project_id, captured_at DESC);
CREATE INDEX reports_time ON reports(captured_at DESC);

CREATE TABLE report_candidates (
  id              TEXT PRIMARY KEY,
  session_key     TEXT NOT NULL,
  env             TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_name    TEXT,
  prompt_id       TEXT,
  reason          TEXT NOT NULL,
  declared_status TEXT,
  task_title      TEXT,
  body            TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  late            INTEGER NOT NULL DEFAULT 0,
  captured_at     TEXT NOT NULL,
  promoted_report_id TEXT,
  promoted_at     TEXT,
  redactions      INTEGER NOT NULL DEFAULT 0,
  truncations     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX report_candidates_project ON report_candidates(project_id, captured_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Deliveries: the handoff of one report to one ChatGPT conversation. destination_json is the frozen destination.
CREATE TABLE deliveries (
  id                     TEXT PRIMARY KEY,
  report_id              TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  project_id             TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_name           TEXT,
  session_key            TEXT NOT NULL,
  task_title             TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN ('report_captured','destination_missing','destination_unverified',
                           'ready_for_handoff','copied','awaiting_user_send','user_confirmed_sent','delivery_uncertain','user_discarded')),
  destination_json       TEXT,
  review                 TEXT NOT NULL DEFAULT 'none' CHECK (review IN ('none','requested','received','follow_up_drafted','follow_up_sent','closed')),
  include_review_request INTEGER NOT NULL DEFAULT 1,
  message                TEXT,
  message_sha256         TEXT,
  message_chars          INTEGER,
  parts_json             TEXT NOT NULL DEFAULT '[]',
  follow_up_draft        TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  auto_key               TEXT UNIQUE,                 -- set for the delivery created automatically on capture (one per report)
  state_changed_at       TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX deliveries_report ON deliveries(report_id);
CREATE INDEX deliveries_project_state ON deliveries(project_id, state);

CREATE TABLE delivery_events (
  id          TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  actor_json  TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX delivery_events_delivery ON delivery_events(delivery_id, at);

-- ---------------------------------------------------------------------------------------------------------------
-- Activity feed and notifications
CREATE TABLE activity (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,           -- stable, derived from the cause: re-recording is a no-op
  at              TEXT NOT NULL,
  project_id      TEXT,
  project_name    TEXT,
  source          TEXT NOT NULL,
  session_key     TEXT,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','attention','error')),
  title           TEXT NOT NULL,
  description     TEXT,
  requires_action INTEGER NOT NULL DEFAULT 0,
  resolved_at     TEXT,
  links_json      TEXT NOT NULL DEFAULT '[]',
  read_at         TEXT
);
CREATE INDEX activity_project ON activity(project_id, seq DESC);
CREATE INDEX activity_unread ON activity(read_at) WHERE read_at IS NULL;

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  project_id  TEXT,
  at          TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  native      TEXT NOT NULL,
  push        TEXT NOT NULL,
  read_at     TEXT,
  target_json TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX notifications_time ON notifications(at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Pending actions: the human approval boundary for anything typed into Claude.
CREATE TABLE pending_actions (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('claude_prompt','permission')),
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','executed','failed','expired','superseded')),
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_key      TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  text             TEXT,
  summary          TEXT NOT NULL,
  report_id        TEXT,
  delivery_id      TEXT,
  created_at       TEXT NOT NULL,
  created_by_json  TEXT NOT NULL,
  approvable_by    TEXT NOT NULL CHECK (approvable_by IN ('desktop','desktop_or_other_device','any_approver')),
  decided_at       TEXT,
  decided_by_json  TEXT,
  executed_at      TEXT,
  failure          TEXT,
  expires_at       TEXT NOT NULL,
  correlation_key  TEXT UNIQUE                     -- e.g. the raw event that raised a permission request
);
CREATE INDEX pending_actions_status ON pending_actions(status, created_at DESC);
CREATE INDEX pending_actions_session ON pending_actions(session_key);

-- ---------------------------------------------------------------------------------------------------------------
-- Devices, pairing, request idempotency
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  platform       TEXT NOT NULL,
  scopes_json    TEXT NOT NULL,
  trusted        INTEGER NOT NULL DEFAULT 0,
  token_hash     TEXT NOT NULL UNIQUE,              -- sha-256 of the bearer token; the token itself is never stored
  push_provider  TEXT,
  push_token     TEXT,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT,
  last_seen_via  TEXT,
  revoked_at     TEXT
);

CREATE TABLE pairing_offers (
  id              TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,
  scopes_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  redeemed_at     TEXT,
  redeemed_by     TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE idempotency (
  key             TEXT NOT NULL,
  principal       TEXT NOT NULL,
  route           TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (key, principal, route)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Claude Code hook installation records (what Mini-Summa wrote, so uninstall removes exactly that)
CREATE TABLE hook_installs (
  env           TEXT PRIMARY KEY,
  settings_path TEXT NOT NULL,
  handler_id    TEXT NOT NULL,
  plan_hash     TEXT NOT NULL,
  backup_path   TEXT,
  installed_at  TEXT NOT NULL
);
`;

// A project can link an existing ChatGPT Project. Only its address and a title are stored; nothing of its content is.
// Existing projects get NULLs: they have no link, and nothing else about them changes.
const V2 = `
ALTER TABLE projects ADD COLUMN chatgpt_project_url   TEXT;
ALTER TABLE projects ADD COLUMN chatgpt_project_scope TEXT;
ALTER TABLE projects ADD COLUMN chatgpt_project_title TEXT;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', sql: V1 },
  { version: 2, name: 'chatgpt project link', sql: V2 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
