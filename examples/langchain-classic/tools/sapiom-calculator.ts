/**
 * Calculator tool - created with sapiomTool() from the start
 */
import { SapiomClient, sapiomTool } from "@sapiom/langchain-classic";
import { z } from "zod";

/**
 * Create calculator tool with built-in Sapiom tracking
 */
export function createCalculatorTool(sapiomClient: SapiomClient) {
  return sapiomTool(
    async ({ expression }: { expression: string }) => {
      console.log(`    [Tool] Calculating: ${expression}...`);
      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        // Only allow safe math operations
        if (!/^[\d\s+\-*/.()]+$/.test(expression)) {
          throw new Error("Invalid characters in expression");
        }
        const result = eval(expression);
        return `${expression} = ${result}`;
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    },
    {
      name: "calculate",
      description:
        "Calculate mathematical expressions (supports +, -, *, /, parentheses)",
      schema: z.object({
        expression: z
          .string()
          .describe('Math expression to evaluate (e.g., "42 * 1.5 + 10")'),
      }),
    },
    {
      sapiomClient,
    }
  );
}
