---
"@sapiom/harness": patch
---

Submit injected prompts as a bracketed paste, so a click that sends a prompt to the CLI chat lands as one prompt and actually sends. Multi-line prompts (the canvas chat prepends step context to every question) no longer submit at their first newline, and the trailing Enter is a keypress rather than a race against the coding agent's paste heuristic — which is why the same click sometimes needed a manual Enter. Sessions whose harness never enables bracketed paste keep the previous raw write.
