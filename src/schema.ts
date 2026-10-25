// Immutable initial schema. Future changes use numbered, transactional migrations.
export const SCHEMA_VERSION = 1;
export const SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE scopes (
 id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE,
 generation INTEGER NOT NULL DEFAULT 0, consent_revision INTEGER NOT NULL DEFAULT 0,
 learning_allowed INTEGER NOT NULL DEFAULT 0, runtime_epoch INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE nodes (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
 type TEXT NOT NULL CHECK(type IN ('event','memory')),
 revision INTEGER NOT NULL, generation INTEGER NOT NULL, consent_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 body TEXT, search_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 valid_from INTEGER, valid_to INTEGER, projection_visible INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX nodes_scope ON nodes(scope_id,status,type);
CREATE INDEX nodes_order ON nodes(scope_id,type,status,created_at,id);
CREATE TABLE ingress (
 scope_id TEXT NOT NULL REFERENCES scopes(id), key_hash TEXT NOT NULL,
 payload_hash TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(id),
 PRIMARY KEY(scope_id,key_hash)
) STRICT;
CREATE TABLE dependencies (
 child_id TEXT NOT NULL REFERENCES nodes(id), parent_id TEXT NOT NULL REFERENCES nodes(id),
 parent_revision INTEGER NOT NULL, PRIMARY KEY(child_id,parent_id)
) STRICT;
CREATE INDEX dependencies_parent ON dependencies(parent_id);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
 kind TEXT NOT NULL CHECK(kind IN ('memory','training')),
 generation INTEGER NOT NULL, consent_revision INTEGER NOT NULL, refs TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','published','revoked')),
 draft TEXT, lease_owner TEXT, lease_token TEXT, lease_deadline REAL,
 result_id TEXT
) STRICT;
CREATE INDEX jobs_scope ON jobs(scope_id,status);
CREATE TABLE outbox (
 id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
 node_id TEXT NOT NULL REFERENCES nodes(id), node_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','acked','revoked'))
) STRICT;
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
 generation INTEGER NOT NULL, consent_revision INTEGER NOT NULL, refs TEXT NOT NULL,
 manifest TEXT, status TEXT NOT NULL CHECK(status IN ('registered','active','revoked'))
) STRICT;
CREATE TABLE revocations (
 id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
 target_id TEXT, generation INTEGER NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(node_id UNINDEXED, statement);
INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete',1);
`;
