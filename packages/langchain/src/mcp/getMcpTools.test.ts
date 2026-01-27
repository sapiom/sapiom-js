/**
 * Tests for getMcpTools
 */

import { getMcpTools } from "./getMcpTools";
import type { McpToolMetadata } from "./types";

// Helper to create a mock MCP client
function createMockClient(
  servers: Record<
    string,
    {
      url?: string;
      command?: string;
      args?: string[];
      transport?: "http" | "sse" | "stdio";
      type?: "http" | "sse" | "stdio";
    }
  >,
  toolsByServer: Record<
    string,
    Array<{
      name: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>
  > = {},
) {
  return {
    config: {
      mcpServers: servers,
    },
    async getTools(serverName: string) {
      return toolsByServer[serverName] ?? [];
    },
  };
}

describe("getMcpTools", () => {
  describe("metadata attachment", () => {
    it("attaches MCP metadata under __sapiom namespace", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
        },
        {
          weather: [{ name: "get_weather", description: "Get weather" }],
        },
      );

      const tools = await getMcpTools(client);

      expect(tools).toHaveLength(1);
      expect(tools[0].metadata).toBeDefined();
      expect(tools[0].metadata?.__sapiom).toBeDefined();

      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;
      expect(mcp.serverName).toBe("weather");
    });

    it("preserves existing tool metadata", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
        },
        {
          weather: [
            {
              name: "get_weather",
              metadata: { customKey: "customValue", version: "1.0" },
            },
          ],
        },
      );

      const tools = await getMcpTools(client);

      expect(tools[0].metadata?.customKey).toBe("customValue");
      expect(tools[0].metadata?.version).toBe("1.0");
      expect(tools[0].metadata?.__sapiom).toBeDefined();
    });

    it("preserves existing __sapiom metadata", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
        },
        {
          weather: [
            {
              name: "get_weather",
              metadata: { __sapiom: { existingKey: "existingValue" } },
            },
          ],
        },
      );

      const tools = await getMcpTools(client);

      const sapiom = tools[0].metadata?.__sapiom as Record<string, unknown>;
      expect(sapiom.existingKey).toBe("existingValue");
      expect(sapiom.mcp).toBeDefined();
    });
  });

  describe("HTTP/SSE connections", () => {
    it("extracts metadata for HTTP transport", async () => {
      const client = createMockClient(
        {
          api: { url: "https://api.example.com/mcp", transport: "http" },
        },
        {
          api: [{ name: "call_api" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.serverName).toBe("api");
      expect(mcp.serverUrl).toBe("https://api.example.com/mcp");
      expect(mcp.transportType).toBe("http");
      expect(mcp.isRemote).toBe(true);
      expect(mcp.serverUrlParsed).toEqual({
        protocol: "https",
        hostname: "api.example.com",
        pathname: "/mcp",
        port: null,
      });
    });

    it("extracts metadata for SSE transport", async () => {
      const client = createMockClient(
        {
          stream: {
            url: "https://stream.example.com:8080/events",
            type: "sse",
          },
        },
        {
          stream: [{ name: "subscribe" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.transportType).toBe("sse");
      expect(mcp.isRemote).toBe(true);
      expect(mcp.serverUrlParsed?.port).toBe(8080);
    });

    it("infers HTTP transport from url property", async () => {
      const client = createMockClient(
        {
          api: { url: "https://api.example.com/mcp" }, // no explicit transport
        },
        {
          api: [{ name: "call_api" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.transportType).toBe("http");
      expect(mcp.isRemote).toBe(true);
    });
  });

  describe("stdio connections", () => {
    it("extracts metadata for stdio transport", async () => {
      const client = createMockClient(
        {
          calculator: {
            command: "npx",
            args: ["@example/calc-mcp"],
            transport: "stdio",
          },
        },
        {
          calculator: [{ name: "calculate" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.serverName).toBe("calculator");
      expect(mcp.serverUrl).toBeUndefined();
      expect(mcp.serverUrlParsed).toBeUndefined();
      expect(mcp.transportType).toBe("stdio");
      expect(mcp.isRemote).toBe(false);
    });

    it("infers stdio transport from command property", async () => {
      const client = createMockClient(
        {
          local: { command: "python", args: ["server.py"] }, // no explicit transport
        },
        {
          local: [{ name: "run_local" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.transportType).toBe("stdio");
      expect(mcp.isRemote).toBe(false);
    });
  });

  describe("URL parsing", () => {
    it("parses URL with port", async () => {
      const client = createMockClient(
        {
          api: { url: "https://localhost:3000/api/mcp" },
        },
        {
          api: [{ name: "test" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.serverUrlParsed).toEqual({
        protocol: "https",
        hostname: "localhost",
        pathname: "/api/mcp",
        port: 3000,
      });
    });

    it("parses URL without port", async () => {
      const client = createMockClient(
        {
          api: { url: "https://api.example.com/v1/mcp" },
        },
        {
          api: [{ name: "test" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.serverUrlParsed?.port).toBeNull();
    });

    it("handles different protocols", async () => {
      const client = createMockClient(
        {
          api: { url: "http://internal.local/mcp" },
        },
        {
          api: [{ name: "test" }],
        },
      );

      const tools = await getMcpTools(client);
      const mcp = (tools[0].metadata?.__sapiom as { mcp: McpToolMetadata }).mcp;

      expect(mcp.serverUrlParsed?.protocol).toBe("http");
    });
  });

  describe("multiple servers", () => {
    it("loads tools from all servers", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
          calculator: { command: "npx", args: ["calc"] },
        },
        {
          weather: [{ name: "get_weather" }, { name: "get_forecast" }],
          calculator: [{ name: "calculate" }],
        },
      );

      const tools = await getMcpTools(client);

      expect(tools).toHaveLength(3);

      const weatherTools = tools.filter(
        (t) => (t.metadata?.__sapiom as any)?.mcp?.serverName === "weather",
      );
      const calcTools = tools.filter(
        (t) => (t.metadata?.__sapiom as any)?.mcp?.serverName === "calculator",
      );

      expect(weatherTools).toHaveLength(2);
      expect(calcTools).toHaveLength(1);
    });

    it("filters to specific servers when options.servers provided", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
          calculator: { command: "npx", args: ["calc"] },
          notifications: { url: "https://notify.example.com/mcp" },
        },
        {
          weather: [{ name: "get_weather" }],
          calculator: [{ name: "calculate" }],
          notifications: [{ name: "send_notification" }],
        },
      );

      const tools = await getMcpTools(client, {
        servers: ["weather", "calculator"],
      });

      expect(tools).toHaveLength(2);

      const serverNames = tools.map(
        (t) => (t.metadata?.__sapiom as any)?.mcp?.serverName,
      );
      expect(serverNames).toContain("weather");
      expect(serverNames).toContain("calculator");
      expect(serverNames).not.toContain("notifications");
    });

    it("skips non-existent servers in filter", async () => {
      const client = createMockClient(
        {
          weather: { url: "https://weather.example.com/mcp" },
        },
        {
          weather: [{ name: "get_weather" }],
        },
      );

      const tools = await getMcpTools(client, {
        servers: ["weather", "nonexistent"],
      });

      expect(tools).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty server config", async () => {
      const client = createMockClient({}, {});

      const tools = await getMcpTools(client);

      expect(tools).toHaveLength(0);
    });

    it("handles server with no tools", async () => {
      const client = createMockClient(
        {
          empty: { url: "https://empty.example.com/mcp" },
        },
        {
          empty: [],
        },
      );

      const tools = await getMcpTools(client);

      expect(tools).toHaveLength(0);
    });

    it("handles tools without metadata property", async () => {
      const client = createMockClient(
        {
          api: { url: "https://api.example.com/mcp" },
        },
        {
          api: [{ name: "test" }], // no metadata property
        },
      );

      const tools = await getMcpTools(client);

      expect(tools[0].metadata).toBeDefined();
      expect(tools[0].metadata?.__sapiom).toBeDefined();
    });
  });
});
