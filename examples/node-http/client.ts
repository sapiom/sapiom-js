/**
 * Sapiom Node HTTP Client
 *
 * Demonstrates @sapiom/node-http integration - a native Node.js HTTP client
 * that automatically handles:
 * - Pre-emptive authorization (before requests)
 * - Reactive payment handling (on 402 errors)
 *
 * Usage: Use createClient() and call client.request() for HTTP requests
 */
import { createClient as createNodeHttpClient } from "@sapiom/node-http";
import dotenv from "dotenv";

dotenv.config();

// Configuration from environment
const DUMMY_SERVER_URL =
  process.env.DUMMY_SERVER_URL || "http://localhost:3101";
const SAPIOM_API_KEY = process.env.SAPIOM_API_KEY || "demo-key";
const SAPIOM_API_URL =
  process.env.SAPIOM_API_URL || "http://localhost:3000/v1";

/**
 * Create a Sapiom-wrapped Node.js HTTP client
 *
 * Uses native Node.js http/https modules under the hood
 */
export function createClient() {
  return createNodeHttpClient({
    apiKey: SAPIOM_API_KEY,
    baseURL: SAPIOM_API_URL,
    agentName: `demo-node-http-${Date.now()}`,
  });
}

// Export base URL for building full URLs
export const baseUrl = DUMMY_SERVER_URL;

// Export configuration for logging
export const config = {
  dummyServerUrl: DUMMY_SERVER_URL,
  sapiomApiUrl: SAPIOM_API_URL,
  sdkName: "@sapiom/node-http",
};
