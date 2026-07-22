---
"@sapiom/harness": patch
---

Wire the Studio's Deploy, Prod-run, and Run-local buttons to their direct routes instead of typing a command into the coding agent:

- **Deploy** streams build status and refreshes the workflow once it publishes, flipping the Draft/Deployed state.
- **Prod-run** starts a real execution and hands the new execution off to the run inspector, so it shows up in the Steps view.
- **Run-local** runs the workflow offline with capabilities stubbed and reports the outcome — no network, no spend.

These three actions now run without a coding-agent session, so they consume no LLM credits. Debug, Explain, and free-form prompts still go through the coding agent, and Visualize is unchanged.
