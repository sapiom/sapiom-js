---
"@sapiom/harness": patch
---

Update the bottom toast to the design-system widget spec: the tone now lives in a leading icon — a green circled check for success, a neutral ⓘ for information, a red ⚠ for errors — instead of a red edge stripe on every toast (which error-coded even "Path copied."). The card itself is the shared floating surface every popover uses. Toasts default to the error tone; positive results (copy confirmations, deploy success, describe finished, agents found, up-to-date/downloaded update checks) opt into success, and neutral status (deploy progress, editor hand-offs, empty scans) opts into info. Also: spring entrance and a short exit animation, the auto-dismiss timer pauses while hovered or focused, and the dismiss control is the shared 22px icon button.
