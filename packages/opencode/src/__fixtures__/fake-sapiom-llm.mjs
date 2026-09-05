import { createServer } from "node:http";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const port = Number(valueAfter("--port") ?? 0);

const server = createServer(async (request, response) => {
  if (
    request.method !== "POST" ||
    request.url !== "/v2/openai/v1/chat/completions"
  ) {
    response.writeHead(404).end("not found");
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  console.log(
    JSON.stringify({
      modelHeader: request.headers["x-sapiom-model"],
      hasApiKey: request.headers["x-sapiom-api-key"] === "poc-placeholder",
      messages: body.messages?.length ?? 0,
      tools: body.tools?.length ?? 0,
      responseFormat: body.response_format?.type ?? null,
    }),
  );

  const answer =
    body.response_format?.type === "json_schema"
      ? JSON.stringify({ title: "POC thread" })
      : "POC_OK";

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-sapiom-served-class": "poc",
    "x-sapiom-lane": "local",
  });
  const base = {
    id: "chatcmpl-poc",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "smart",
  };
  response.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: answer.slice(0, 4) },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  setTimeout(() => {
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: answer.slice(4) },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  }, 40);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(1);
  console.log(`fake-sapiom-llm=http://127.0.0.1:${address.port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
