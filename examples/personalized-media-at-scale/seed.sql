-- Read-side seed for personalized-media-at-scale.
--
-- These rows are the INPUT the agent renders media for — a recipient list it
-- reads and never writes. Seeding them is what makes a first run produce real
-- images or clips instead of ending at "0 rows to render". Insert your own rows
-- (or point `dbHandle` at your own database) and it renders for yours instead.
--
-- The addresses are RFC 2606 documentation domains on purpose: they cannot
-- receive mail, and the agent skips sending to them rather than reporting a
-- delivery that went nowhere.
--
-- Idempotent: safe to run again after a re-provision.

CREATE TABLE IF NOT EXISTS media_recipients (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL,
  context    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO media_recipients (name, email, context)
SELECT * FROM (VALUES
  ('Ada Lovelace', 'ada@example.com',
   'loves vintage computing and long-distance cycling'),
  ('Grace Hopper', 'grace@example.com',
   'sailing weekends, precise minimalist aesthetic'),
  ('Alan Turing', 'alan@example.com',
   'morning runs, chess, quiet English countryside')
) AS demo(name, email, context)
WHERE NOT EXISTS (SELECT 1 FROM media_recipients);
