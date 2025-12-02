/**
 * Weather Tool - Plain LangChain tool
 *
 * No Sapiom-specific code needed - middleware handles tracking automatically.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const weatherTool = tool(
  async ({ city }: { city: string }) => {
    console.log(`    [Tool] Fetching weather for ${city}...`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const conditions = ["Sunny", "Cloudy", "Rainy", "Snowy"];
    const weather = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = Math.floor(Math.random() * 30) + 10;

    return `Weather in ${city}: ${weather}, ${temp}°C`;
  },
  {
    name: "get_weather",
    description: "Get current weather for a city",
    schema: z.object({
      city: z.string().describe("City name"),
    }),
  }
);
