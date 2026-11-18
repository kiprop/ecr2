-- In-app notifications shown under the bell in the top bar
CREATE TABLE inbox (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,          -- returned | accepted | submitted | change | close | signoff | deadline | overdue | welcome
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,                   -- app-relative path, e.g. /?item=42
  country_code  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at       TIMESTAMPTZ
);
CREATE INDEX ON inbox (user_id, read_at, created_at DESC);
