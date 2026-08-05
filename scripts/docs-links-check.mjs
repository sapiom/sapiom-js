import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ORIGIN = "https://docs.sapiom.ai";
const SUPPORTED_LOCAL_CLAUDE_COMMAND =
  "claude mcp add sapiom-project -- npx -y @sapiom/mcp";
const SUPPORTED_LOCAL_CODEX_COMMAND =
  "codex mcp add sapiom-project -- npx -y @sapiom/mcp";
const SUPPORTED_HOSTED_CLAUDE_COMMAND =
  'claude mcp add --scope user --transport http sapiom-cloud https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"';
const SUPPORTED_HOSTED_CODEX_COMMAND =
  "codex mcp add sapiom-cloud --url https://api.sapiom.ai/v1/mcp --bearer-token-env-var SAPIOM_API_KEY";
/**
 * Public pages in the approved Docs.sapiom.ai information architecture.
 * Product source may link only to these canonical routes; redirects are for
 * old released binaries and bookmarks, not permission to emit stale links.
 */
export const CANONICAL_DOC_ROUTES = new Set([
  "/",
  "/agent-studio/account-and-privacy",
  "/agent-studio/canvas-steps-and-code",
  "/agent-studio/install",
  "/agent-studio/overview",
  "/agent-studio/sessions",
  "/agent-studio/workspaces-and-projects",
  "/agents/authoring",
  "/agents/quick-start",
  "/capabilities",
  "/capabilities/ai-models",
  "/capabilities/audio",
  "/capabilities/browser",
  "/capabilities/compute",
  "/capabilities/data",
  "/capabilities/domains",
  "/capabilities/email-enrichment",
  "/capabilities/file-storage",
  "/capabilities/github-export",
  "/capabilities/images",
  "/capabilities/messaging",
  "/capabilities/repositories",
  "/capabilities/scraping",
  "/capabilities/search",
  "/capabilities/verify",
  "/concepts/agents-and-agent-projects",
  "/concepts/local-and-cloud",
  "/concepts/studio-mcp-sdk-and-dashboard",
  "/concepts/workspaces-and-sessions",
  "/guides/build",
  "/guides/configure-authentication-and-runtime-inputs",
  "/guides/connect-claude-code-with-mcp",
  "/guides/create-from-a-template",
  "/guides/deploy",
  "/guides/inspect",
  "/guides/run-in-production",
  "/guides/schedule",
  "/guides/test-locally",
  "/guides/use-signals",
  "/integration/mcp-servers/remote",
  "/integration/sdk",
  "/privacy-policy",
  "/reference/agent-studio",
  "/reference/credentials-and-configuration",
  "/terms-of-use",
  "/troubleshooting/agent-studio",
  "/troubleshooting/build-deploy-run",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);
const IGNORED_REPOSITORY_PATHS = new Set([
  "scripts/docs-links-check.mjs",
  "scripts/docs-links-check.test.mjs",
]);

const REQUIRED_EMITTED_LINKS = [
  "https://docs.sapiom.ai/agent-studio/account-and-privacy",
  "https://docs.sapiom.ai/agent-studio/install",
  "https://docs.sapiom.ai/agent-studio/overview",
  "https://docs.sapiom.ai/agents/authoring",
  "https://docs.sapiom.ai/agents/quick-start",
  "https://docs.sapiom.ai/guides/connect-claude-code-with-mcp",
  "https://docs.sapiom.ai/reference/agent-studio",
];

function normalizeRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isTestFixturePath(path) {
  return /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/i.test(path);
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const path = join(directory, entry.name);
    const relativePath = normalizeRelativePath(root, path);
    if (IGNORED_REPOSITORY_PATHS.has(relativePath)) return [];
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
    if (entry.isDirectory()) return walk(root, path);
    return entry.isFile() ? [path] : [];
  });
}

function extractDocsLinkMatches(content) {
  return [
    ...content.matchAll(
      /(?<![\w.-])(?:https?:\/\/)?docs\.sapiom\.[a-z]+(?:\/[^\s<>"'`)\]]*)?/gi,
    ),
  ].map((match) => ({
    index: match.index ?? 0,
    rawLink: match[0].replace(/[.,;:]+$/, ""),
  }));
}

export function extractDocsLinks(content) {
  return extractDocsLinkMatches(content).map(({ rawLink }) => rawLink);
}

export function validateDocsLinkContent(filePath, content) {
  const errors = [];
  for (const { index, rawLink } of extractDocsLinkMatches(content)) {
    const url = new URL(
      rawLink.includes("://") ? rawLink : `https://${rawLink}`,
    );
    const line = content.slice(0, index).split("\n").length;
    if (url.origin !== DOCS_ORIGIN) {
      errors.push(
        `${filePath}:${line} emits malformed docs origin ${url.origin}`,
      );
      continue;
    }
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    if (CANONICAL_DOC_ROUTES.has(pathname)) continue;
    errors.push(
      `${filePath}:${line} emits noncanonical docs route ${pathname}`,
    );
  }
  return errors;
}

export function validateSupportedMcpSetupContent(filePath, content) {
  const errors = [];
  for (const match of content.matchAll(/(?:claude|codex) mcp add[^\n]*/gi)) {
    const command = match[0];
    const line = content.slice(0, match.index ?? 0).split("\n").length;
    if (
      command.includes("@sapiom/mcp") &&
      !/\bsapiom-project\b/.test(command) &&
      !/\$\{PROJECT_MCP_ALIAS\}/.test(command)
    ) {
      errors.push(
        `${filePath}:${line} registers local @sapiom/mcp without the supported sapiom-project client alias`,
      );
    }
    if (
      (/--transport\s+http/i.test(command) ||
        /--url\s+https?:\/\/api\.sapiom\./i.test(command) ||
        /https?:\/\/api\.sapiom\./i.test(command)) &&
      !/\bsapiom-cloud\b/.test(command)
    ) {
      errors.push(
        `${filePath}:${line} registers Sapiom Cloud MCP without the supported sapiom-cloud client alias`,
      );
    }
  }

  if (
    /\.(?:json|md)$/i.test(filePath) &&
    /["']sapiom-dev["']\s*:/.test(content)
  ) {
    errors.push(
      `${filePath} uses sapiom-dev as a client configuration key instead of the server's wire identity`,
    );
  }
  return errors;
}

export function validateRepository(root = REPOSITORY_ROOT) {
  const candidates = walk(root)
    .filter((path) => TEXT_EXTENSIONS.has(extname(path)))
    .filter((path) => !path.endsWith("CHANGELOG.md"));

  const files = candidates.map((path) => ({
    path,
    relativePath: normalizeRelativePath(root, path),
    content: readFileSync(path, "utf8"),
  }));
  const errors = files.flatMap(({ relativePath, content }) => [
    ...validateDocsLinkContent(relativePath, content),
    ...(isTestFixturePath(relativePath)
      ? []
      : validateSupportedMcpSetupContent(relativePath, content)),
  ]);
  if (errors.length) throw new Error(errors.join("\n"));

  const corpus = files.map(({ content }) => content).join("\n");
  for (const link of REQUIRED_EMITTED_LINKS) {
    if (!corpus.includes(link)) {
      throw new Error(`Required canonical product link is missing: ${link}`);
    }
  }
  for (const command of [
    SUPPORTED_LOCAL_CLAUDE_COMMAND,
    SUPPORTED_LOCAL_CODEX_COMMAND,
    SUPPORTED_HOSTED_CLAUDE_COMMAND,
    SUPPORTED_HOSTED_CODEX_COMMAND,
  ]) {
    if (!corpus.includes(command)) {
      throw new Error(
        `Required supported setup command is missing: ${command}`,
      );
    }
  }

  return { files: files.length, links: extractDocsLinks(corpus).length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = validateRepository();
  console.log(
    `Verified ${result.links} Docs.sapiom.ai links across ${result.files} product files.`,
  );
}
