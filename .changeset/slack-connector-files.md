---
"@sapiom/tools": minor
---

`connectors.slack` gains `downloadFile()` and `uploadFile()`, which move files between Slack
and the tenant's file storage by `fileId`. `downloadFile({ file })` copies a file posted in
Slack (a `file_share` message's `files[].id`) into file storage and returns
`{ fileId, contentType, fileName, size }`. `uploadFile({ fileId, channel, threadTs?, title?,
initialComment?, fileName? })` shares a file the tenant owns into a channel or thread and
returns `{ ok, file, permalink }`. Both cap a file at 25 MiB. They need the Slack scopes
`files:read` and `files:write`: a Slack connection made before those were added answers
`403 oauth_scope_not_granted` until Slack is reconnected.
