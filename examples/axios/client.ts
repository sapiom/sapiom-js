/**
 * Sapiom Axios Client
 *
 * Demonstrates @sapiom/axios integration - a drop-in wrapper for Axios
 * that automatically handles:
 * - Pre-emptive authorization (before requests)
 * - Reactive payment handling (on 402 errors)
 *
 * Usage: Just wrap your existing Axios instance with withSapiom()
 */
import { withSapiom } from "@sapiom/axios";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Configuration from environment
const DUMMY_SERVER_URL =
  process.env.DUMMY_SERVER_URL || "http://localhost:3101";
const SAPIOM_API_KEY = process.env.SAPIOM_API_KEY || "demo-key";
const SAPIOM_API_URL =
  process.env.SAPIOM_API_URL || "http://localhost:3000/v1";

/**
 * Create a Sapiom-wrapped Axios client
 *
 * This is all you need - one line to wrap your existing Axios instance!
 */
export function createClient() {
  const baseClient = axios.create({
    baseURL: DUMMY_SERVER_URL,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return withSapiom(baseClient, {
    apiKey: SAPIOM_API_KEY,
    baseURL: SAPIOM_API_URL,
    agentName: `demo-axios-${Date.now()}`,
  });
}

// Export configuration for logging
export const config = {
  dummyServerUrl: DUMMY_SERVER_URL,
  sapiomApiUrl: SAPIOM_API_URL,
  sdkName: "@sapiom/axios",
};
