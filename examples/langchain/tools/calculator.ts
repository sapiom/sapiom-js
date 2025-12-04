/**
 * Calculator Tool - Plain LangChain tool
 *
 * No Sapiom-specific code needed - middleware handles tracking automatically.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const calculatorTool = tool(
  async ({ expression }: { expression: string }) => {
    console.log(`    [Tool] Calculating: ${expression}...`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
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
  }
);
