/**
 * Who posted a customer-channel message: our team or the customer. Pure, so the rule is testable
 * without Slack or a database.
 */
export type Poster = "team" | "customer";

export interface PosterInput {
  /** The Slack user id of the poster. */
  user: string;
  /** Slack Connect fields on the message event; present when the channel is shared. */
  userTeam?: string;
  team?: string;
  /** The workspace the connector is installed in (ours); the envelope's `teamId`. */
  envelopeTeamId: string;
  /** `team.slack_team_ids`; unset means only the connector's own workspace. */
  teamSlackTeamIds?: readonly string[];
  /** `customers.test_user_ids`. */
  testUserIds?: readonly string[];
}

/**
 * `team` when the poster's workspace is one of ours. A listed test user is always `customer`, so
 * one person can play both sides from the same workspace. When Slack names no poster workspace the
 * message came from the workspace the connector sees, which is ours.
 */
export function classifyPoster(i: PosterInput): Poster {
  if (i.testUserIds?.includes(i.user)) return "customer";
  const ours = i.teamSlackTeamIds ?? [i.envelopeTeamId];
  const workspace = i.userTeam ?? i.team ?? i.envelopeTeamId;
  return ours.includes(workspace) ? "team" : "customer";
}
