/**
 * The Sylon event catalog: raw Slack events from the connector and the domain `issue.*` events
 * the agents emit to each other.
 *
 * Every schema is a loose `z.object()`. The engine hands a run the whole event payload, and a
 * strict schema would fail the run on any key Slack (or a newer producer) adds.
 */
import { z } from "zod/v4";

/** Where a customer message lives in Slack. */
export const SlackRef = z.object({
  channel: z.string(),
  ts: z.string(),
  threadTs: z.string().optional(),
});
export type SlackRef = z.infer<typeof SlackRef>;

// --- Raw Slack events (connector → adapters and button owners) ---

/** The inner Slack `message` event, as the Events API delivers it. */
export const SlackMessage = z.object({
  type: z.literal("message"),
  channel: z.string(),
  user: z.string(),
  text: z.string().default(""),
  ts: z.string(),
  thread_ts: z.string().optional(),
  channel_type: z.string().optional(),
  team: z.string().optional(),
  event_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
});
export type SlackMessage = z.infer<typeof SlackMessage>;

export const SlackReaction = z.object({
  type: z.literal("reaction_added"),
  user: z.string(),
  reaction: z.string(),
  item: z.object({ type: z.string(), channel: z.string(), ts: z.string() }),
  item_user: z.string().optional(),
  event_ts: z.string().optional(),
});
export type SlackReaction = z.infer<typeof SlackReaction>;

/** What the connector wraps every Events API event in (`slack.message.created`, `slack.reaction_added`). */
function slackEnvelope<T extends z.ZodType>(event: T) {
  return z.object({
    teamId: z.string(),
    apiAppId: z.string().optional(),
    eventId: z.string(),
    eventTime: z.number().optional(),
    event,
  });
}

export const SlackMessageCreated = slackEnvelope(SlackMessage);
export type SlackMessageCreated = z.infer<typeof SlackMessageCreated>;

export const SlackReactionAdded = slackEnvelope(SlackReaction);
export type SlackReactionAdded = z.infer<typeof SlackReactionAdded>;

export const SlackAction = z.object({
  action_id: z.string(),
  block_id: z.string().optional(),
  value: z.string().optional(),
  type: z.string(),
  action_ts: z.string().optional(),
});
export type SlackAction = z.infer<typeof SlackAction>;

/**
 * A Block Kit button click. The connector emits Slack's interaction payload unwrapped, minus
 * `token` and `response_url`, deduped on `trigger_id`.
 */
export const SlackBlockActions = z.object({
  type: z.literal("block_actions"),
  trigger_id: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string().optional(),
    name: z.string().optional(),
  }),
  team: z.object({ id: z.string() }).optional(),
  channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  container: z
    .object({
      type: z.string(),
      message_ts: z.string().optional(),
      channel_id: z.string().optional(),
    })
    .optional(),
  message: z
    .object({ ts: z.string(), thread_ts: z.string().optional() })
    .optional(),
  actions: z.array(SlackAction).min(1),
});
export type SlackBlockActions = z.infer<typeof SlackBlockActions>;

export const SlackEvents = {
  "slack.message.created": SlackMessageCreated,
  "slack.reaction_added": SlackReactionAdded,
  "slack.block_actions": SlackBlockActions,
} as const;
export type SlackEventType = keyof typeof SlackEvents;

// --- Domain events (agent → agent) ---

export const Envelope = z.object({
  issueId: z.string().uuid(),
  accountId: z.string().uuid(),
  source: z.literal("slack"),
  /** Originating Slack event_id or trigger_id; also the emit `id`, so a retried emit dedups. */
  causationId: z.string().min(1),
  slack: SlackRef,
});
export type Envelope = z.infer<typeof Envelope>;

export const Events = {
  "issue.created": Envelope.extend({
    category: z.string(),
    priority: z.string(),
    title: z.string(),
  }),
  "issue.message_added": Envelope.extend({
    messageId: z.string().uuid(),
    text: z.string(),
  }),
  "issue.escalate": Envelope.extend({
    summary: z.string(),
    requestedBy: z.string(),
  }),
  "issue.on_hold": Envelope.extend({ linearIdentifier: z.string() }),
  "issue.nudged": Envelope.extend({ kind: z.string() }),
} as const;
export type EventType = keyof typeof Events;
export type EventPayload<T extends EventType> = z.infer<(typeof Events)[T]>;

/** Every event type a Sylon run can be started by, raw or domain. */
export const AllEvents = { ...SlackEvents, ...Events } as const;
export type AnyEventType = keyof typeof AllEvents;

export function isEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(Events, type);
}
