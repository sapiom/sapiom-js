/**
 * Sapiom Fetch Client
 *
 * Demonstrates @sapiom/fetch integration - a drop-in replacement for native fetch
 * that automatically handles:
 * - Pre-emptive authorization (before requests)
 * - Reactive payment handling (on 402 errors)
 *
 * Usage: Replace native fetch() with createFetch() - works exactly the same!
 */
import { createFetch } from "@sapiom/fetch";
import dotenv from "dotenv";

dotenv.config();

// Configuration from environment
const DUMMY_SERVER_URL =
  process.env.DUMMY_SERVER_URL || "http://localhost:3101";
const SAPIOM_API_KEY = process.env.SAPIOM_API_KEY || "demo-key";
const SAPIOM_API_URL =
  process.env.SAPIOM_API_URL || "http://localhost:3000/v1";

/**
 * Create a Sapiom-wrapped fetch function
 *
 * This returns a function that works exactly like native fetch()!
 */
export function createClient() {
  return createFetch({
    apiKey: SAPIOM_API_KEY,
    baseURL: SAPIOM_API_URL,
    agentName: `demo-fetch-${Date.now()}`,
  });
}

// Export base URL for building full URLs (fetch requires full URLs)
export const baseUrl = DUMMY_SERVER_URL;

// Export configuration for logging
export const config = {
  dummyServerUrl: DUMMY_SERVER_URL,
  sapiomApiUrl: SAPIOM_API_URL,
  sdkName: "@sapiom/fetch",
};
