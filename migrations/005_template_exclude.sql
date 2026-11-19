-- A standard requirement can be switched off for one country (it does not apply under that country's law).
ALTER TABLE template_local ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT false;
