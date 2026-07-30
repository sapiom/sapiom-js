import { describe, expect, it } from "vitest";
import { parseGitHubRepoUrl, defaultDirNameFor } from "./github-url";

describe("parseGitHubRepoUrl", () => {
  describe("HTTPS URLs", () => {
    it("parses a plain HTTPS URL without .git", () => {
      const ref = parseGitHubRepoUrl("https://github.com/owner/repo");
      expect(ref).toEqual({
        owner: "owner",
        repo: "repo",
        cloneUrl: "https://github.com/owner/repo.git",
      });
    });

    it("parses a HTTPS URL with .git suffix", () => {
      const ref = parseGitHubRepoUrl("https://github.com/owner/repo.git");
      expect(ref).toEqual({
        owner: "owner",
        repo: "repo",
        cloneUrl: "https://github.com/owner/repo.git",
      });
    });

    it("handles dashes and dots in owner/repo names", () => {
      const ref = parseGitHubRepoUrl("https://github.com/my-org/my.repo-name");
      expect(ref?.owner).toBe("my-org");
      expect(ref?.repo).toBe("my.repo-name");
    });

    it("trims surrounding whitespace before parsing", () => {
      const ref = parseGitHubRepoUrl("  https://github.com/owner/repo  ");
      expect(ref?.owner).toBe("owner");
      expect(ref?.repo).toBe("repo");
    });

    it("strips trailing path segments after the repo name", () => {
      const ref = parseGitHubRepoUrl("https://github.com/owner/repo/tree/main");
      expect(ref?.owner).toBe("owner");
      expect(ref?.repo).toBe("repo");
    });

    it("normalises the cloneUrl to HTTPS even for SSH input", () => {
      const ref = parseGitHubRepoUrl("git@github.com:owner/repo.git");
      expect(ref?.cloneUrl).toBe("https://github.com/owner/repo.git");
    });
  });

  describe("SSH URLs", () => {
    it("parses an SSH URL with .git suffix", () => {
      const ref = parseGitHubRepoUrl("git@github.com:owner/repo.git");
      expect(ref).toEqual({
        owner: "owner",
        repo: "repo",
        cloneUrl: "https://github.com/owner/repo.git",
      });
    });

    it("parses an SSH URL without .git suffix", () => {
      // Some tools omit the .git suffix for SSH; we accept both forms.
      const ref = parseGitHubRepoUrl("git@github.com:owner/repo");
      expect(ref).toEqual({
        owner: "owner",
        repo: "repo",
        cloneUrl: "https://github.com/owner/repo.git",
      });
    });
  });

  describe("invalid inputs", () => {
    it("returns null for an empty string", () => {
      expect(parseGitHubRepoUrl("")).toBeNull();
    });

    it("returns null for a GitLab URL", () => {
      expect(parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("returns null for a plain hostname", () => {
      expect(parseGitHubRepoUrl("github.com/owner/repo")).toBeNull();
    });

    it("returns null for a bare repo name with no host", () => {
      expect(parseGitHubRepoUrl("owner/repo")).toBeNull();
    });

    it("returns null for a GitHub user profile URL (no repo)", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner")).toBeNull();
    });

    it("returns null for an SSH URL for a non-GitHub host", () => {
      expect(parseGitHubRepoUrl("git@bitbucket.org:owner/repo.git")).toBeNull();
    });
  });
});

describe("defaultDirNameFor", () => {
  it("returns just the repo name", () => {
    const ref = parseGitHubRepoUrl("https://github.com/my-org/my-repo");
    expect(defaultDirNameFor(ref!)).toBe("my-repo");
  });
});
