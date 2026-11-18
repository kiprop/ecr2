-- Country rules (board composition etc.), country-only checklist items, per-country due dates.
ALTER TABLE countries ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '{}';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS country_code TEXT REFERENCES countries(code) ON DELETE CASCADE;
ALTER TABLE template_local ADD COLUMN IF NOT EXISTS due_days INT;
ALTER TABLE template_local ALTER COLUMN text DROP NOT NULL;
