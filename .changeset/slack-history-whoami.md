---
"@sapiom/tools": minor
---

`connectors.slack` gains `history()` (Slack `conversations.history`: a channel's top-level messages, paginated, with `oldest` / `latest` bounds) and `whoAmI()` (Slack `auth.test`: the bot's own `user_id` and `bot_id`, to recognise its own posts). Agents that read a channel no longer need their own Slack bot token.
