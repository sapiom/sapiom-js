-- Read-side seed for nl-db-query-endpoint.
--
-- The endpoint ANSWERS QUESTIONS about a database; it never writes to one. These
-- tables are the input it reads, so seeding them is what makes the first
-- translation meaningful — a SELECT written against a schema that does not exist
-- demonstrates nothing. Point `dbHandle` (or `connectionString`) at your own
-- database and it queries yours instead.
--
-- Deliberately small, deliberately boring, and joinable, so a plain-English
-- question has something to translate INTO.
--
-- Idempotent: safe to run again after a re-provision.

CREATE TABLE IF NOT EXISTS customers (
  id      bigserial PRIMARY KEY,
  name    text NOT NULL,
  country text NOT NULL,
  plan    text NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers (id),
  issued_on   date   NOT NULL,
  amount_usd  numeric(10, 2) NOT NULL,
  paid        boolean NOT NULL
);

INSERT INTO customers (name, country, plan)
SELECT * FROM (VALUES
  ('Northwind Traders', 'US', 'enterprise'),
  ('Contoso Ltd',       'US', 'pro'),
  ('Fabrikam GmbH',     'DE', 'pro'),
  ('Tailspin Toys',     'GB', 'free'),
  ('Adventure Works',   'AU', 'enterprise'),
  ('Wingtip Cycles',    'CA', 'free')
) AS demo(name, country, plan)
WHERE NOT EXISTS (SELECT 1 FROM customers);

INSERT INTO invoices (customer_id, issued_on, amount_usd, paid)
SELECT
  1 + (n % 6),
  (CURRENT_DATE - (n * 3))::date,
  ROUND((120 + (n * 91) % 4200)::numeric, 2),
  (n % 4) <> 0
FROM generate_series(0, 59) AS s(n)
WHERE NOT EXISTS (SELECT 1 FROM invoices);
