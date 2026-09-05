import {
  createOpencodeClient,
  type OpencodeClient,
} from "@assistant-ui/react-opencode";

export function createAssistantUiOpenCodeClient(
  baseUrl: string,
): OpencodeClient {
  const client = createOpencodeClient({ baseUrl });

  // react-opencode 0.2.22 maps Assistant UI's title hook to OpenCode's
  // compaction endpoint. OpenCode already titles new sessions while prompting,
  // so suppress the duplicate call until the adapter separates those actions.
  client.session.summarize = async () => ({ data: true }) as never;

  return client;
}
