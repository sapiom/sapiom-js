/**
 * Sapiom Fetch Demo
 *
 * Demonstrates @sapiom/fetch integration with a real-world workflow:
 * 1. GET /api/crm/customers - Fetch customer list (authorization)
 * 2. POST /api/sms - Send SMS to each customer (payment)
 * 3. POST /api/campaigns/analytics - Get campaign analytics (authorization + payment)
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
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
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
  log("  Sapiom SDK Demo: @sapiom/fetch", "bright");
  log("═".repeat(60), "bright");

  log("\n  SDK Integration:", "yellow");
  logInfo(`Package: ${config.sdkName}`);
  logInfo(`Dummy Server: ${config.dummyServerUrl}`);
  logInfo(`Sapiom API: ${config.sapiomApiUrl}`);

  log("\n  What this demonstrates:", "yellow");
  logInfo("• Pre-emptive authorization before HTTP requests");
  logInfo("• Automatic payment handling on 402 responses");
  logInfo("• Drop-in replacement for native fetch()");

  // Create client
  const safeFetch = createClient();

  // ============================================
  // Step 1: Fetch customers (authorization)
  // ============================================
  logSection("Step 1: Fetch Customers (Authorization Required)");

  let customers: Customer[] = [];
  try {
    logRequest("GET", "/api/crm/customers");
    logInfo("This request requires Sapiom authorization...");

    const url = new URL("/api/crm/customers", baseUrl);
    url.searchParams.set("limit", "3");
    url.searchParams.set("segment", "enterprise");

    const response = await safeFetch(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { customers: Customer[] };
    customers = data.customers;
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
    }
    process.exit(1);
  }

  // ============================================
  // Step 2: Send SMS to each customer (payment)
  // ============================================
  logSection("Step 2: Send SMS to Customers (Payment Required)");

  const campaignId = `campaign-${Date.now()}`;
  let smsCount = 0;

  for (const customer of customers) {
    try {
      logRequest("POST", "/api/sms");
      logInfo(`Sending to ${customer.name} at ${customer.phone}...`);
      logInfo("This request requires payment ($0.0075 per SMS)...");

      const response = await safeFetch(`${baseUrl}/api/sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: customer.phone,
          message: `Hi ${customer.name}! Check out our latest offers.`,
          campaignId,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        messageId: string;
        status: string;
        price: number;
      };
      smsCount++;
      logSuccess(`SMS sent - ID: ${data.messageId}`);
      logInfo(`Status: ${data.status}, Price: $${data.price}`);
    } catch (error: any) {
      logError(`Failed to send SMS to ${customer.name}: ${error.message}`);
      if (error.name === "AuthorizationDeniedError") {
        logInfo("Payment transaction was denied by Sapiom policy");
      }
    }
  }

  logInfo(`\nTotal SMS sent: ${smsCount}/${customers.length}`);

  // ============================================
  // Step 3: Get campaign analytics (auth + payment)
  // ============================================
  logSection("Step 3: Campaign Analytics (Authorization + Payment)");

  try {
    logRequest("POST", "/api/campaigns/analytics");
    logInfo(`Getting analytics for campaign: ${campaignId}`);
    logInfo("This request requires both authorization AND payment...");

    const response = await safeFetch(`${baseUrl}/api/campaigns/analytics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      name: string;
      status: string;
      metrics?: {
        sent: number;
        delivered: number;
        openRate: number;
      };
    };
    logSuccess("Analytics retrieved successfully");
    logInfo(`Campaign: ${data.name}`);
    logInfo(`Status: ${data.status}`);
    if (data.metrics) {
      logInfo(`Messages sent: ${data.metrics.sent}`);
      logInfo(`Delivered: ${data.metrics.delivered}`);
      logInfo(`Open rate: ${data.metrics.openRate}%`);
    }
  } catch (error: any) {
    logError(`Failed to get analytics: ${error.message}`);
    if (error.name === "AuthorizationDeniedError") {
      logInfo("Transaction was denied by Sapiom policy");
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
  logInfo(`• Customers fetched: ${customers.length}`);
  logInfo(`• SMS messages sent: ${smsCount}`);
  logInfo(`• Campaign ID: ${campaignId}`);

  log("\n  Key Takeaways:", "yellow");
  logInfo("• Works exactly like native fetch() API");
  logInfo("• Authorization happens transparently before requests");
  logInfo("• 402 payment errors are handled automatically");
  logInfo("• All transactions tracked in Sapiom dashboard");
  console.log("");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
