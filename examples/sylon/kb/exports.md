# Data exports

Workspace admins can export data from **Settings → Data → Export**.

- Formats: CSV (one file per table, zipped) and JSON Lines.
- Exports run in the background. Small workspaces finish in minutes; very large ones can take a
  few hours. The admin who started the export gets an email with a download link.
- Download links expire after 7 days. Start a new export to get a fresh link.
- Only one export per workspace runs at a time; a second request waits for the first.
- Timestamps are UTC in ISO 8601. Deleted records are not included.
- Scheduled exports (daily or weekly, to an S3 bucket) are available on the Business plan.
