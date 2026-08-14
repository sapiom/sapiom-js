# Product: Studio Run Workspace

## Problem

Agent authors can create workflows in Studio, but meaningful runs are hard to launch and harder to inspect. Inputs are bypassed, successful artifacts are reduced to raw payloads or anonymous links, and step evidence expands into a crowded document. Authors leave Studio for the dashboard even though Studio is where they are actively debugging and improving the agent.

## Success metric

At least 80% of executions inspected in Studio have no subsequent dashboard-open action from the run-inspection context. Measure distinct inspected execution ids and the subset with a dashboard-open event; never collect prompt or payload content.

## Announcement — the blog post before the feature

Studio now gives every agent run a proper workspace. Run with real inputs, watch each attempt unfold, and inspect outputs as the artifacts they are—not a wall of JSON or anonymous links. Local tests and cloud runs use the same controls and evidence model while keeping their safety differences explicit. When something looks wrong, the exact step context is ready for the coding agent without leaving Studio.

## Screens

- `mockups/run-sheet.html` — the unified Local/Cloud run-input sheet.
- `mockups/run-workspace.html` — the artifact-first Focus workspace with chronological attempts and evidence tabs.
