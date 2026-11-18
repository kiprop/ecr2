-- ECR 2.0 schema

CREATE TABLE countries (
  code           TEXT PRIMARY KEY,              -- ISO-3, e.g. LSO
  name           TEXT NOT NULL,
  phase          TEXT NOT NULL DEFAULT 'operate' CHECK (phase IN ('establish','operate','close','closed')),
  close_status   TEXT NOT NULL DEFAULT 'none'    CHECK (close_status IN ('none','requested','running','done')),
  entity_type    TEXT,
  authority      TEXT,
  registered_on  TEXT,
  currency       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,          -- stored lower-case
  name           TEXT NOT NULL,
  title          TEXT,
  role           TEXT NOT NULL CHECK (role IN ('admin','reviewer','leader','director','focal')),
  status         TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','inactive')),
  entra_oid      TEXT,
  cal_token      TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_countries (
  user_id       INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code  TEXT NOT NULL REFERENCES countries(code) ON DELETE CASCADE,
  PRIMARY KEY (user_id, country_code)
);

-- Standard checklists per phase. stage is used for close-out gating (1-4).
CREATE TABLE templates (
  id          SERIAL PRIMARY KEY,
  phase       TEXT NOT NULL CHECK (phase IN ('setup','annual','close')),
  seq         INT  NOT NULL,
  text        TEXT NOT NULL,
  due_days    INT  NOT NULL DEFAULT 90,          -- days after the cycle / plan opens
  stage       INT,
  active      BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE template_local (
  template_id   INT  NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  country_code  TEXT NOT NULL REFERENCES countries(code) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  PRIMARY KEY (template_id, country_code)
);

-- One per country per annual cycle (and one 'setup' / 'close' plan when used)
CREATE TABLE cycles (
  id            SERIAL PRIMARY KEY,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  kind          TEXT NOT NULL CHECK (kind IN ('annual','setup','close')),
  label         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','signed_off','closed')),
  opened_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  signed_by     INT REFERENCES users(id),
  signed_at     TIMESTAMPTZ,
  UNIQUE (country_code, kind, label)
);

-- Registers: registration, board, poa, bank. Data kept as JSON so fields can evolve.
CREATE TABLE register_records (
  id            SERIAL PRIMARY KEY,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  kind          TEXT NOT NULL CHECK (kind IN ('registration','board','poa','bank')),
  data          JSONB NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON register_records (country_code, kind);

-- Everything someone has to do
CREATE TABLE obligations (
  id            SERIAL PRIMARY KEY,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  cycle_id      INT REFERENCES cycles(id),
  area          TEXT NOT NULL CHECK (area IN ('setup','annual','registration','board','poa','banking','change','close')),
  template_id   INT REFERENCES templates(id),
  seq           INT,
  stage         INT,
  title         TEXT NOT NULL,
  requirement   TEXT,
  due_date      DATE,
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','submitted','returned','accepted','na')),
  source_type   TEXT,          -- registration_renewal | legal_review | board_term | board_coi | poa_expiry | bank_confirmation | director_notice
  source_id     INT,
  change_type   TEXT,          -- signatory | board | poa | registration | close
  payload       JSONB NOT NULL DEFAULT '{}',
  review_note   TEXT,
  submitted_at  TIMESTAMPTZ,
  submitted_by  INT REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON obligations (country_code, status);
CREATE INDEX ON obligations (status, due_date);

CREATE TABLE documents (
  id             SERIAL PRIMARY KEY,
  obligation_id  INT NOT NULL REFERENCES obligations(id),
  label          TEXT,
  filename       TEXT NOT NULL,
  mime           TEXT,
  size_bytes     INT,
  storage_path   TEXT NOT NULL,
  uploaded_by    INT REFERENCES users(id),
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail
CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id       INT REFERENCES users(id),
  country_code  TEXT,
  obligation_id INT,
  action        TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX ON events (country_code, at DESC);
CREATE INDEX ON events (obligation_id);
CREATE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'events is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- Sent reminders, so the worker never sends the same one twice
CREATE TABLE notifications (
  id             SERIAL PRIMARY KEY,
  user_id        INT REFERENCES users(id),
  obligation_id  INT,
  kind           TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL UNIQUE,
  subject        TEXT,
  status         TEXT NOT NULL DEFAULT 'logged',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
