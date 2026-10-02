# Sylon demo: rehearsal checklist and failure drill

Every command runs from `examples/sylon` with `SAPIOM_API_KEY` set to the org key. Times are from
the Sapiom Internal runs on 2026-10-02.

## Before the demo (T-30 min)

1. **Reset.** `pnpm run reset-demo` closes every open issue and redraws its card. Intake links a
   new message to any open issue it judges to be the same problem, so leftovers would capture the
   demo's messages. `--dry-run` lists them first.
2. **Install without urgent-pager.** `pnpm run setup --skip urgent-pager` (or plain
   `pnpm run setup`, which leaves optional agents out). Expect `no changes` if nothing moved since
   the last rehearsal, or about 40 s for a full deploy. Confirm the summary lists every trigger
   as attached, including `controller ← cron */2 * * * *`.
3. **Take urgent-pager out** if a rehearsal left it in, so it can be added live: detach its
   `issue.created` trigger (`DELETE /v1/workflows/triggers/<id>`; the id is in
   `.sapiom/fleet-state.json`). setup re-attaches it.
4. **Prepare the replay.** Set `scripts/replay.json` `prefix` to `""` for the live show (rehearsals
   keep `[sylon test]`). For the script to post itself, export
   `SLACK_REPLAY_USER_TOKEN`, a user token (`xoxp-...`) of the test customer with `chat:write`.
   Without it, someone posts each step by hand as the customer while the script watches.
5. **Open the tabs:** the customer channel, the triage channel, the on-call user's DMs with the
   Sylon bot, the Sapiom Events page (`https://app.sapiom.ai/agents/events`), and Linear
   (Sylon Issues).

## Run the demo

1. `pnpm run replay`. It prints the steps (watch-only) or posts them, then prints each receipt,
   run, issue card, draft card, reply and nudge with links. It exits 1 if any Sylon run fails.
2. **Bug report.** The issue card appears in triage about 30 s after the post; the draft card,
   citing the troubleshooting-build-deploy-run page, about 20 s after that.
3. **Threaded follow-up.** It links to the same issue (no new card); copilot posts a new draft.
4. **Live-add urgent-pager.** Before the outage step, run `pnpm run setup --only urgent-pager`
   (37 s on Internal, under the 2-minute budget). The summary shows one agent and one trigger;
   no other agent changes.
5. **Outage.** Intake classifies it urgent; the on-call user gets a DM with the title and a link
   to the triage thread, about 50 s after the post.
6. **Question.** Copilot drafts the answer from the schedule page (`catchupPolicy` skips or replays missed slots).
   Click **Approve**: the reply lands in the customer thread and the card shows who sent it.
7. **Thank-you.** No card: Jev's `is_issue` came back 0.04 in both rehearsals.
8. **Escalate.** Click **Escalate** on the bug's draft card. One Linear issue appears in Sylon
   Issues, and both threads get "Tracked as SAP-n". The card shows On Hold and the Linear id.
9. **Nudges.** After `nudge.minutes` (5), the controller posts "No owner yet", "Draft waiting
   for a decision" and "Customer is waiting for a reply" in the triage threads. To show it on demand, run
   `sapiom agents run --input '{"jevCheck":true}'` in `agents/controller`.

Afterwards: `pnpm run reset-demo`, and cancel the Linear issues the escalation created.

## Failure drill: a disconnected Linear

This shows a failed run that is replayed from the Events page once the cause is fixed. Rehearse it
in a test org or with a throwaway issue; it creates one Linear issue.

1. In the Sapiom dashboard, open **Connectors** and disconnect Linear.
2. Post a bug in the customer channel and wait for its draft card.
3. Click **Escalate**. The draft card shows Escalated, and the `issue.escalate` receipt's
   escalation run fails: the Linear relay refuses the call. The issue stays as it was (no On Hold, no "Tracked as" reply), because
   escalation records nothing until Linear answers.
4. Open the receipt on the Events page (`https://app.sapiom.ai/agents/events/<receiptId>`; the
   replay script prints the link). The fire shows as failed, with the relay error.
5. Reconnect Linear (Connectors, with the relay slug `linear`).
6. On the same receipt, click **Replay**. The new escalation run creates one Linear issue, replies
   in both threads, and moves the issue On Hold. A second replay is a no-op: escalation finds the
   recorded link and only repeats the identifier in triage.

## Troubleshooting

| Symptom                                     | Check                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No receipt for a customer post              | The post came from a bot or was an edit; the connector drops both. Post as a real user.              |
| A demo message joined an old issue          | An issue was left open. `pnpm run reset-demo`, then post again.                                      |
| No draft card                               | The copilot's `issue.created` trigger is detached; rerun `pnpm run setup`.                           |
| No DM for the outage                        | Intake classified it below urgent (the issue card shows the priority), or urgent-pager is not armed. |
| Nudges every 2 minutes in the test channels | The controller cron is attached. Detach it between rehearsals; `pnpm run setup` re-attaches it.      |
