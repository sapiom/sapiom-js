import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs/promises");
vi.mock("node:os");

// Import after mocking
import {
  resolveEnvironment,
  readCredentials,
  writeCredentials,
  clearCredentials,
} from "./credentials.js";

const mockHomedir = "/mock/home";
const credentialsPath = path.join(mockHomedir, ".sapiom", "credentials.json");

const sampleCredentials = {
  apiKey: "sk-test-key",
  tenantId: "tenant-123",
  organizationName: "Test Org",
  apiKeyId: "key-456",
};

const sampleFile = {
  currentEnvironment: "production",
  environments: {
    production: {
      appURL: "https://app.sapiom.ai",
      apiURL: "https://api.sapiom.ai",
      credentials: sampleCredentials,
    },
    staging: {
      appURL: "https://staging.app.sapiom.ai",
      apiURL: "https://staging.api.sapiom.ai",
      services: { prelude: "https://staging.prelude.sapiom.ai" },
    },
  },
};

beforeEach(() => {
  vi.mocked(os.homedir).mockReturnValue(mockHomedir);
  vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fs.writeFile).mockResolvedValue();
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEnvironment", () => {
  it("should return production defaults when no file exists", async () => {
    const env = await resolveEnvironment();
    expect(env).toEqual({
      name: "production",
      appURL: "https://app.sapiom.ai",
      apiURL: "https://api.sapiom.ai",
      services: {},
      credentials: null,
    });
  });

  it("should return environment from file when it exists", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const env = await resolveEnvironment();
    expect(env).toEqual({
      name: "production",
      appURL: "https://app.sapiom.ai",
      apiURL: "https://api.sapiom.ai",
      services: {},
      credentials: sampleCredentials,
    });
  });

  it("should use env override over file's currentEnvironment", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const env = await resolveEnvironment("staging");
    expect(env.name).toBe("staging");
    expect(env.appURL).toBe("https://staging.app.sapiom.ai");
    expect(env.services).toEqual({
      prelude: "https://staging.prelude.sapiom.ai",
    });
    expect(env.credentials).toBeNull();
  });

  it("should use file's currentEnvironment when no override", async () => {
    const file = {
      currentEnvironment: "staging",
      environments: sampleFile.environments,
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(file));

    const env = await resolveEnvironment();
    expect(env.name).toBe("staging");
  });

  it("should throw for unknown custom environment without file", async () => {
    await expect(resolveEnvironment("custom")).rejects.toThrow(
      'Unknown environment "custom"',
    );
  });

  it("should throw for unknown environment not in file", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    await expect(resolveEnvironment("nonexistent")).rejects.toThrow(
      'Unknown environment "nonexistent"',
    );
  });

  it("should return null credentials when env has no credentials", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const env = await resolveEnvironment("staging");
    expect(env.credentials).toBeNull();
  });
});

describe("readCredentials", () => {
  it("should return credentials when they exist", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const creds = await readCredentials("production");
    expect(creds).toEqual(sampleCredentials);
  });

  it("should return null when no file exists", async () => {
    const creds = await readCredentials("production");
    expect(creds).toBeNull();
  });

  it("should return null when environment has no credentials", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const creds = await readCredentials("staging");
    expect(creds).toBeNull();
  });

  it("should return null for nonexistent environment", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const creds = await readCredentials("nonexistent");
    expect(creds).toBeNull();
  });
});

describe("writeCredentials", () => {
  it("should create new file when none exists", async () => {
    await writeCredentials(
      "production",
      "https://app.sapiom.ai",
      "https://api.sapiom.ai",
      sampleCredentials,
    );

    expect(fs.mkdir).toHaveBeenCalledWith(path.join(mockHomedir, ".sapiom"), {
      recursive: true,
      mode: 0o700,
    });
    expect(fs.writeFile).toHaveBeenCalledWith(
      credentialsPath,
      expect.any(String),
      { mode: 0o600 },
    );

    const written = JSON.parse(
      vi.mocked(fs.writeFile).mock.calls[0][1] as string,
    );
    expect(written.currentEnvironment).toBe("production");
    expect(written.environments.production.credentials).toEqual(
      sampleCredentials,
    );
  });

  it("should update existing file preserving other environments", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    const newCreds = { ...sampleCredentials, apiKey: "sk-new-key" };
    await writeCredentials(
      "staging",
      "https://staging.app.sapiom.ai",
      "https://staging.api.sapiom.ai",
      newCreds,
    );

    const written = JSON.parse(
      vi.mocked(fs.writeFile).mock.calls[0][1] as string,
    );
    // Production should be preserved
    expect(written.environments.production.credentials).toEqual(
      sampleCredentials,
    );
    // Staging should have new credentials
    expect(written.environments.staging.credentials).toEqual(newCreds);
    // Current environment updated
    expect(written.currentEnvironment).toBe("staging");
  });

  it("should preserve existing services when updating credentials", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    await writeCredentials(
      "staging",
      "https://staging.app.sapiom.ai",
      "https://staging.api.sapiom.ai",
      sampleCredentials,
    );

    const written = JSON.parse(
      vi.mocked(fs.writeFile).mock.calls[0][1] as string,
    );
    expect(written.environments.staging.services).toEqual({
      prelude: "https://staging.prelude.sapiom.ai",
    });
  });

  it("should write file with secure permissions", async () => {
    await writeCredentials(
      "production",
      "https://app.sapiom.ai",
      "https://api.sapiom.ai",
      sampleCredentials,
    );

    expect(fs.mkdir).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: 0o700 }),
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

describe("clearCredentials", () => {
  it("should remove credentials from environment", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    await clearCredentials("production");

    const written = JSON.parse(
      vi.mocked(fs.writeFile).mock.calls[0][1] as string,
    );
    expect(written.environments.production.credentials).toBeUndefined();
    // Other env data preserved
    expect(written.environments.production.appURL).toBe(
      "https://app.sapiom.ai",
    );
  });

  it("should no-op when no file exists", async () => {
    await clearCredentials("production");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("should no-op when environment has no credentials", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    await clearCredentials("staging");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("should no-op for nonexistent environment", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sampleFile));

    await clearCredentials("nonexistent");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
