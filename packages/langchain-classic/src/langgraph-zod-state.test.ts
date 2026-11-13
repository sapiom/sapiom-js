/**
 * The workspace forces every zod onto the catalog version, LangGraph's own
 * copy included. This runs the real LangGraph (no mock) on its zod state API,
 * so a LangGraph that cannot read that zod fails here.
 */
import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph";

describe("LangGraph zod state on the workspace zod", () => {
  it("builds StateGraph(MessagesZodState) and runs one step", async () => {
    const graph = new StateGraph(MessagesZodState)
      .addNode("echo", (state) => ({
        messages: [{ role: "ai", content: `seen ${state.messages.length}` }],
      }))
      .addEdge(START, "echo")
      .addEdge("echo", END)
      .compile();

    const result = await graph.invoke({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      "hi",
      "seen 1",
    ]);
  });
});
