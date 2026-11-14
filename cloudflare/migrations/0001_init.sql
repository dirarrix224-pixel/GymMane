-- GymMane D1 schema. Small structured data only: large JSON, media and backups live in R2.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_exp ON sessions(expires_at);

CREATE TABLE login_attempts (
  k         TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  first_at  INTEGER NOT NULL
);

-- Current state pointer: rev + the immutable R2 object that holds the JSON.
CREATE TABLE state (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev       INTEGER NOT NULL,
  r2_key    TEXT NOT NULL,
  size      INTEGER NOT NULL,
  sha256    TEXT NOT NULL,
  saved_at  INTEGER NOT NULL,
  source    TEXT NOT NULL DEFAULT 'web'
);

-- Every committed version (immutable R2 keys); pruned by the daily job.
CREATE TABLE state_versions (
  user_id   TEXT NOT NULL,
  rev       INTEGER NOT NULL,
  r2_key    TEXT NOT NULL,
  size      INTEGER NOT NULL,
  sha256    TEXT NOT NULL,
  saved_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, rev)
);

CREATE TABLE media (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  type        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE backups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX backups_user ON backups(user_id, created_at);
