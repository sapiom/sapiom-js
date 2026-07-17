---
"@sapiom/harness": patch
---

fix(harness): resume/history rows are distinguishable — real titles + branch/turns/last-active

Resume-history rows were near-indistinguishable: on any long session the title
fell back to the bare `agentSessionId` UUID (the tail-only transcript read
missed the first prompt), and rows carried no differentiating metadata.

The claude-code adapter now derives a human-readable title from Claude's own
generated `ai-title` (falling back to a compaction `summary`, then the first
human prompt, then the directory basename — never a bare UUID), and surfaces
the session's git branch and an exact human-turn count. Transcripts small
enough to scan in full report an exact turn count; larger ones are still read
only at head+tail (so the dropdown never parses a 100MB file) and simply omit
the count. The history dropdown renders branch · turns · last-active under each
title so many sessions in one directory can be told apart.
