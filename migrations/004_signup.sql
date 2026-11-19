-- Self sign-up: a default role for new EGPAF sign-ins, and the office location from Microsoft.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','reviewer','leader','director','focal','viewer'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_location TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_signup BOOLEAN NOT NULL DEFAULT false;
