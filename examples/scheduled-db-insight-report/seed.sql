-- Read-side seed for scheduled-db-insight-report.
--
-- This template REPORTS ON a database; it never writes to one. These tables are
-- the input it reads, so seeding them is what makes a first run produce a real
-- report instead of "0 tables, 0 rows" — which is a successful-looking run that
-- says nothing. Point `dbHandle` (or DATABASE_URL) at your own database and the
-- report is about your data instead.
--
-- Idempotent: safe to run again after a re-provision.

CREATE TABLE IF NOT EXISTS demo_orders (
  id          bigserial PRIMARY KEY,
  placed_on   date        NOT NULL,
  region      text        NOT NULL,
  amount_usd  numeric(10, 2) NOT NULL,
  status      text        NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_signups (
  id          bigserial PRIMARY KEY,
  signed_up_on date       NOT NULL,
  plan        text        NOT NULL,
  source      text        NOT NULL
);

INSERT INTO demo_orders (placed_on, region, amount_usd, status)
SELECT
  (CURRENT_DATE - (n % 28))::date,
  (ARRAY['us-east', 'us-west', 'eu-central', 'apac'])[1 + (n % 4)],
  ROUND((45 + (n * 37) % 900)::numeric, 2),
  (ARRAY['paid', 'paid', 'paid', 'refunded', 'pending'])[1 + (n % 5)]
FROM generate_series(1, 240) AS s(n)
WHERE NOT EXISTS (SELECT 1 FROM demo_orders);

INSERT INTO demo_signups (signed_up_on, plan, source)
SELECT
  (CURRENT_DATE - (n % 28))::date,
  (ARRAY['free', 'free', 'pro', 'enterprise'])[1 + (n % 4)],
  (ARRAY['organic', 'referral', 'paid-search', 'partner'])[1 + (n % 4)]
FROM generate_series(1, 130) AS s(n)
WHERE NOT EXISTS (SELECT 1 FROM demo_signups);
