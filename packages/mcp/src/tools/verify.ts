import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";
import { getAuthenticatedFetch } from "../fetch.js";

const DEFAULT_PRELUDE_URL = "https://prelude.services.sapiom.ai";

export function register(server: McpServer, env: ResolvedEnvironment): void {
  const preludeURL = env.services.prelude ?? DEFAULT_PRELUDE_URL;

  server.tool(
    "sapiom_verify_send",
    "Send a verification code to a phone number via SMS. Returns a verification ID that you'll need to check the code later. Phone number must be in E.164 format (e.g. +15551234567).",
    {
      phoneNumber: z
        .string()
        .regex(
          /^\+[1-9]\d{1,14}$/,
          "Phone number must be in E.164 format (e.g. +15551234567)",
        )
        .describe(
          "Phone number in E.164 format with country code (e.g. +15551234567)",
        ),
    },
    async ({ phoneNumber }) => {
      const sfetch = await getAuthenticatedFetch(env);
      if (!sfetch) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use the sapiom_authenticate tool first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await sfetch(`${preludeURL}/verifications`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target: {
              type: "phone_number",
              value: phoneNumber,
            },
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const message =
            (body.message as string) ??
            `Failed to send verification code (${response.status})`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          id: string;
          status: string;
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Verification code sent to ${phoneNumber}. Verification ID: ${data.id}\n\nAsk the user for the 6-digit code they received, then use sapiom_verify_check to verify it.`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to send verification code: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "sapiom_verify_check",
    "Check a verification code that was sent via sapiom_verify_send. Returns whether the code is correct.",
    {
      verificationId: z
        .string()
        .describe("The verification ID returned by sapiom_verify_send"),
      code: z
        .string()
        .regex(/^\d{6}$/, "Code must be exactly 6 digits")
        .describe("The 6-digit verification code the user received"),
    },
    async ({ verificationId, code }) => {
      const sfetch = await getAuthenticatedFetch(env);
      if (!sfetch) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use the sapiom_authenticate tool first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await sfetch(`${preludeURL}/verifications/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            verificationRequestId: verificationId,
            code,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const message =
            (body.message as string) ??
            `Verification check failed (${response.status})`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          id: string;
          status: string;
        };

        if (data.status === "success") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Verification successful! The code is correct.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Verification ${data.status}. The code may be incorrect or expired.`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Verification check failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
