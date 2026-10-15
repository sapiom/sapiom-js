# Opt-in Lead Follow-up

Follow up with people who asked to hear from you: a demo request, a waitlist
sign-up, a contact form. The agent reads each contact's company site, writes a
personalized first line, verifies the address, sends the first email, and
sends a short sequence of follow-ups on a schedule. Anyone who replies gets no
further emails.

This template only emails contacts you supply with an `optInSource`. It does
not look up or write to people who never contacted you. Unsolicited bulk email
breaks Sapiom's terms of use and the email provider's.

## What it does

```
intake ──▶ scrape ──▶ personalize ──▶ verify ──▶ enroll ──▶ send
 (input)    (web)      (llm.run)     (email     (database)  (email: first touch,
   │                                  verify)               reply check, follow-ups)
   └──────────── scheduled pass: { "campaign": "..." } ────▶ send
```

1. **intake** checks the `contacts` you pass. Each one needs an `email` and an
   `optInSource`, which records where they asked to hear from you. A contact
   missing either is rejected and listed under `rejected` in the output.
2. **scrape** reads each company site (`ctx.sapiom.search.scrape`) for context.
   The site comes from the contact's `domain`, or from their email address when
   it is not a personal mailbox such as gmail.com. Page bodies are truncated
   and never enter shared state.
3. **personalize** asks the live model (`ctx.sapiom.llm.run`) for one first line
   per contact that acknowledges their request. If the model writes nothing for
   a contact, that contact is not emailed.
4. **verify** checks each address (`ctx.sapiom.search.emailSearch.verifyEmail`)
   and drops any that would bounce.
5. **enroll** adds the deliverable contacts to the campaign roster in a Postgres
   database the agent owns (`ctx.sapiom.database`). A contact who is already
   enrolled keeps their place in the sequence. With `dryRun: true` the run
   stops here and returns the plan.
6. **send** makes one pass over the roster:
   - newly enrolled contacts get the first touch;
   - for anyone whose next touch is due, it reads their thread
     (`ctx.sapiom.email.threads.get`) first. A message from anyone other than
     the sending inbox counts as a reply, and the contact is marked `replied`;
   - follow-ups go out as replies in the first touch's thread
     (`ctx.sapiom.email.messages.reply`).

   The run then ends. Every failed send is listed under `sendFailures` in the
   output. If every send on a pass fails, the run ends `failed`.

Input for a first run:

```json
{
  "campaign": "spring-demo-requests",
  "contacts": [
    {
      "email": "jordan@acme.com",
      "optInSource": "demo request form",
      "fullName": "Jordan Rivera",
      "company": "Acme"
    }
  ],
  "senderName": "Dana",
  "inboxId": "dana@mail.yourcompany.com",
  "dripIntervalDays": 3
}
```

- `contacts`: people to enroll. `email` and `optInSource` are required.
  `fullName`, `firstName`, `lastName`, `position`, `company` and `domain` are
  optional. A run takes at most 25.
- `campaign`: the roster name. Defaults to `opt-in-follow-up`.
- `sequence`: overrides the default three touches. Only the first touch uses
  its `subject`, because later touches are replies in the same thread.
- `dripIntervalDays`: days between touches. The default is 3.
- `senderName`: the name used to sign the email.
- `inboxId`: the inbox to send from. A free `sapiom.email` inbox only delivers
  inside your own organization; anything else fails with 403
  `recipient_not_allowed`. To reach real contacts, create an inbox on your own
  domain and pass its address here.
- `dryRun: true`: returns every opener without sending or storing anything.

`sequence`, `dripIntervalDays`, `senderName` and `inboxId` are saved with the
campaign. A later run that passes only `campaign` uses the saved values.

### Follow-ups run on a schedule

There is no paused run waiting between touches. A pause timeout fails the run
on Sapiom; it does not resume it. A wait-then-send loop would therefore stop
after the first email.

Instead, attach a cron trigger to the deployed agent that runs it with
`{ "campaign": "spring-demo-requests" }`. For example, use
`sapiom_dev_agents_schedule` with kind `schedule_cron` and the expression
`0 9 * * 1-5`. Each scheduled run is one pass:

- it sends whatever is due;
- it stops the sequence for anyone who replied;
- it marks finished anyone who has had every touch.

Two overlapping runs on the same campaign do not both send: the second one
stops without sending anything.

### Zero-setup: `{}`

With no `contacts` and no `campaign`, the run works `DEMO_CONTACTS`: three
fabricated opt-ins at `.example` companies.

- **Stand-ins:** `scrape` and `verify` use canned stand-ins for these contacts.
- **Real calls:** `personalize` calls the live model, `enroll` writes to the
  database, and `send` delivers the first touch.
- **Where the demo email goes:** `send` delivers to this agent's own
  Sapiom-hosted inbox (`resolveSenderInbox`), never to the fabricated address.
- **No follow-ups:** demo contacts are stored with status `demo`, so no
  scheduled run ever follows them up.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory, run `npm install`. Then drive the lifecycle through the
   MCP:
   - `sapiom_dev_agents_check`
   - `sapiom_dev_agents_run_local`: capabilities are stubbed. Pass
     `dryRun: true`, which skips the database and the send and costs nothing.
   - `sapiom_dev_agents_link`, then `sapiom_dev_agents_deploy`
   - `sapiom_dev_agents_run`: a real, billed run that enrolls the contacts and
     sends the first touch.

4. Attach the schedule with `sapiom_dev_agents_schedule`, passing the input
   `{ "campaign": "<name>" }`, so the follow-ups go out.

## Files

- `index.ts`: the agent (edit this).
- `index.test.mjs`: unit tests for contact intake, reply detection and opener
  parsing (`npm test`).
- `package.json` / `tsconfig.json`: pinned SDK deps and typecheck config.
- `app/`: the dashboard this template ships (`node server.mjs`). It shows every
  contact with the opener the model wrote and the email it went out in, the
  sequence, and the run's step timings. See `app/README.md`. `preview.png` is
  its screenshot, referenced from `template.json` → `app.preview`.

Run `npm run typecheck` to confirm it compiles.
