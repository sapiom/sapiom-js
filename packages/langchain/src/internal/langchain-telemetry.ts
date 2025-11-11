/**
 * LangChain-Specific Telemetry Utilities
 *
 * Functions specific to LangChain integration.
 * General telemetry (call sites, runtime info) is in sdk/src/lib/telemetry.ts
 */

/**
 * Detect entry method from stack trace
 *
 * Determines how the user called the model:
 * - "invoke" - via model.invoke()
 * - "generate" - via model.generate() directly
 * - "stream" - via model.stream()
 * - "batch" - via model.batch()
 */
export function detectEntryMethod(stack?: string): 'invoke' | 'generate' | 'stream' | 'batch' {
  try {
    const stackTrace = stack || new Error().stack || '';
    const frames = stackTrace.split('\n');

    // Look for LangChain method calls in stack
    for (const frame of frames) {
      if (frame.includes('.invoke(')) return 'invoke';
      if (frame.includes('.stream(')) return 'stream';
      if (frame.includes('.batch(')) return 'batch';
    }

    // Default to generate (direct call)
    return 'generate';
  } catch (error) {
    return 'generate';
  }
}

/**
 * Collect LangChain dependency versions
 *
 * Attempts to read package.json from installed LangChain packages.
 * Fails gracefully if packages not available.
 */
export function collectDependencyVersions(): Record<string, string> {
  const deps: Record<string, string> = {};

  const packagesToCheck = [
    '@langchain/core',
    '@langchain/openai',
    '@langchain/anthropic',
    '@langchain/google-genai',
    '@langchain/langgraph',
  ];

  for (const pkg of packagesToCheck) {
    try {
      // Try to require package.json
      // This works in Node.js environments
      const pkgJson = require(`${pkg}/package.json`);
      deps[pkg] = pkgJson.version;
    } catch {
      // Package not installed or not accessible
      continue;
    }
  }

  return deps;
}
