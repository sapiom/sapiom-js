/**
 * Sapiom Node HTTP Demo - Free Endpoints Only
 *
 * Demonstrates @sapiom/node-http with free endpoints that only require authorization:
 * 1. GET /api/public/time - Server time (no auth required)
 * 2. GET /api/public/status - Server status (no auth required)
 * 3. GET /api/crm/customers - Customer list (authorization required)
 *
 * This demo does NOT require a Sapiom balance. Use this to test:
 * - Basic SDK integration
 * - Authorization flow
 * - Usage rules (limit number of calls)
 *
 * Run: npm start
 */
import { createClient, baseUrl, config } from "./client";

// ANSI colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log("");
  log("─".repeat(60), "dim");
  log(`  ${title}`, "bright");
  log("─".repeat(60), "dim");
}

function logRequest(method: string, path: string) {
  log(`\n  ${method} ${path}`, "cyan");
}

function logSuccess(message: string) {
  log(`  ✓ ${message}`, "green");
}

function logInfo(message: string) {
  log(`    ${message}`, "dim");
}

function logError(message: string) {
  log(`  ✗ ${message}`, "red");
}

interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  segment: string;
  revenue: number;
}

async function main() {
  console.log("");
  log("═".repeat(60), "bright");
  log("  Sapiom SDK Demo: @sapiom/node-http (Free Endpoints)", "bright");
  log("═".repeat(60), "bright");

  log("\n  SDK Integration:", "yellow");
  logInfo(`Package: ${config.sdkName}`);
  logInfo(`Server: ${config.dummyServerUrl}`);
  logInfo(`Sapiom API: ${config.sapiomApiUrl}`);

  log("\n  What this demonstrates:", "yellow");
  logInfo("• Free endpoints (no payment required)");
  logInfo("• Authorization-only endpoints");
  logInfo("• Usage tracking in Sapiom dashboard");

  // Create client
  const client = createClient();

  // ============================================
  // Step 1: Public endpoint (no auth needed)
  // ============================================
  logSection("Step 1: Public Endpoint (No Auth Required)");

  try {
    logRequest("GET", "/api/public/time");
    logInfo("This endpoint is completely free...");

    const response = await client.request<{
      time: string;
      timezone: string;
    }>({
      method: "GET",
      url: `${baseUrl}/api/public/time`,
    });

    logSuccess(`Server time: ${response.data.time}`);
    logInfo(`Timezone: ${response.data.timezone}`);
  } catch (error: any) {
    logError(`Failed: ${error.message}`);
    console.error("Full stack trace:", error.stack);
  }

  // ============================================
  // Step 2: Another public endpoint
  // ============================================
  logSection("Step 2: Server Status (No Auth Required)");

  try {
    logRequest("GET", "/api/public/status");
    logInfo("Another free endpoint...");

    const response = await client.request<{
      status: string;
      version: string;
      uptime: number;
    }>({
      method: "GET",
      url: `${baseUrl}/api/public/status`,
    });

    logSuccess(`Status: ${response.data.status}`);
    logInfo(`Version: ${response.data.version}`);
    logInfo(`Uptime: ${Math.floor(response.data.uptime)}s`);
  } catch (error: any) {
    logError(`Failed: ${error.message}`);
    console.error("Full stack trace:", error.stack);
  }

  // ============================================
  // Step 3: CRM endpoint (authorization required)
  // ============================================
  logSection("Step 3: Fetch Customers (Authorization Required)");

  let customers: Customer[] = [];
  try {
    logRequest("GET", "/api/crm/customers");
    logInfo("This endpoint requires Sapiom authorization...");
    logInfo("(Free, but tracks usage for policy enforcement)");

    const response = await client.request<{
      customers: Customer[];
      total: number;
    }>({
      method: "GET",
      url: `${baseUrl}/api/crm/customers?limit=3&segment=enterprise`,
      headers: { "Content-Type": "application/json" },
    });

    customers = response.data.customers;
    logSuccess(`Fetched ${customers.length} customers`);

    for (const customer of customers) {
      logInfo(
        `• ${customer.name} (${customer.phone}) - $${customer.revenue.toLocaleString()}`
      );
    }
  } catch (error: any) {
    logError(`Failed to fetch customers: ${error.message}`);
    if (error.name === "AuthorizationDeniedError") {
      logInfo("Transaction was denied by Sapiom policy");
      logInfo("Check your Rules at https://app.sapiom.ai/rules");
    }
  }

  // ============================================
  // Summary
  // ============================================
  console.log("");
  log("═".repeat(60), "bright");
  log("  Demo Complete", "green");
  log("═".repeat(60), "bright");

  log("\n  Summary:", "yellow");
  logInfo("• 2 public endpoints called (no auth)");
  logInfo(`• 1 CRM endpoint called (authorization tracked)`);
  logInfo(`• Customers fetched: ${customers.length}`);

  log("\n  Next steps:", "yellow");
  logInfo("1. Check Activity at https://app.sapiom.ai/activity");
  logInfo("2. Create a Usage rule at https://app.sapiom.ai/rules");
  logInfo("3. Run again to test authorization denial");
  logInfo("");
  logInfo("To test paid endpoints (requires balance):");
  logInfo("  npm run full");
  console.log("");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
