-- A triage channel belongs to one desk: button clicks and thread notes find their desk by channel,
-- so two desks sharing one would leave the second unreachable. Setup rejects duplicates before
-- writing; this index is the backstop. It fails on a database that already holds duplicates, which
-- must be given distinct channels first.

create unique index desks_triage_channel_unique on desks (triage_channel);
