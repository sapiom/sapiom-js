# Agent Studio — version management

Video: `agent289-full-loop-v2-trimmed.mp4` · 4m33s · no audio.

## Why this matters

Studio could build and deploy an agent. After that it went quiet.

It could not tell you which version was live. Or what a label pointed at. Or
whether the code in front of you was the code running in the cloud.

All of that lived in the web dashboard and the API. Now it is in Studio.

## Walkthrough

**0:00 — Where we start.**
The new Versions tab. Five releases, newest first.
The header says `LIVE ON CLOUD 1.0.2 9b3b387`. That is the version serving
traffic, and its label.
It also says `YOUR FILES 1.0.2`. The code on disk is that exact version.

**0:30 — The agent as it stands.**
The Steps tab reads `5 steps · 1 exit`.

**1:05 — A step is added.**
A new `salute` step goes into the agent.
Steps now reads `6 steps · 1 exit`.
The edit happens in an editor. Studio has no code editor.

**1:13 — Studio notices on its own.**
Back on Versions, `YOUR FILES` now reads **`not deployed`**.
Nothing told it about the edit. It re-read the project and found no deployed
version matching.
This question had no answer anywhere in the old UI.

**1:33 — Deploy.**
One click, from the header.
Studio switches to Steps and confirms: *Deployed to Sapiom*.
The build runs and goes live.

**2:26 — The new release is there.**
Back on Versions: six entries now, not five.
The new build carries `latest` and is live.
`YOUR FILES` matches it again.

**2:40 — Naming it.**
`1.0.3` is typed straight onto the row. No dialog.
The header switches from the raw sha to `LIVE ON CLOUD 1.0.3 ec80f40`.

**2:59 — Run it locally.**
The run sheet opens, asking for input.
Local means: your code on disk, Sapiom calls stubbed.

**3:06 — Local run finishes.**
`local run completed`. The output contains the new step's contribution.

**3:37 — Run it on the cloud.**
Cloud means: the deployed version, real capabilities.
`prod run completed`.
Both runs agree, because the local copy and the live version are the same code.

**4:07 — Ending state.**
Six versions. Newest is labelled and live. Working copy matches.

## What is new

**The Versions tab.** Recent releases, with sha, labels, age and build status.

**`latest` is always the top row.** It is the build a deploy just produced. It is
the row people look for.

**Labelled releases come next.** A tagged release never gets buried under a few
untagged deploys.

**`LIVE ON CLOUD` and `YOUR FILES`, side by side.** When they differ you see it
at a glance.

**A version chip beside the agent name.** Shows cloud and local together, from
anywhere in Studio. Switches version without opening the tab.

**Labels on the row.** Create one or move one inline.

**`latest` cannot be set by hand.** It is computed from the newest ready build,
so it never goes stale. Trying to set it returns the server's own refusal.

**Roll back to any ready build.** The confirm appears *only* when pinning
backwards — the case that has a consequence. It says outright that later deploys
will not go live.

**A pinned agent says so.** A banner, with one-click *Resume following latest*.
Otherwise a deploy that "did nothing" is a confusing afternoon.

**Cloud run status now appears.** It used to report `execution not found` for
runs that had completed perfectly well.

## Two things to know

Studio has no code editor. The Code tab generates a snippet for calling the
agent — it is not a source view.

For agents built from git, Studio says nothing about your working copy. It knows
which commit is live. It cannot know whether your checkout matches. So it stays
quiet rather than guess.
