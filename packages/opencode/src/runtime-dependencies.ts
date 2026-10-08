import {
  access,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const name = "@opencode-ai/plugin";

async function installedPluginDirectory(): Promise<string> {
  // This pinned package has import-only exports and no package.json export.
  // Follow node_modules ancestors, without consulting NODE_PATH/user globals.
  let ancestor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const directory = join(ancestor, "node_modules", name).replace(
      /([/\\])app\.asar([/\\])/,
      "$1app.asar.unpacked$2",
    );
    try {
      await access(join(directory, "package.json"));
      return await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("The installed OpenCode plugin is missing");
    ancestor = parent;
  }
}

/** Link installed code only; each runtime still owns its private HOME/config. */
export async function prepareRuntimeDependencies(
  configDirectory: string,
): Promise<void> {
  const directory = await installedPluginDirectory();
  const installed = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
  };
  const owner = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  const version = owner.dependencies?.["opencode-ai"];
  if (
    !version ||
    owner.dependencies?.[name] !== version ||
    installed.name !== name ||
    installed.version !== version
  )
    throw new Error(
      "The installed OpenCode plugin does not match the pinned runtime",
    );
  await access(join(directory, "dist", "index.js"));
  const modules = join(configDirectory, "node_modules", "@opencode-ai");
  await mkdir(modules, { recursive: true, mode: 0o700 });
  await symlink(
    directory,
    join(modules, "plugin"),
    process.platform === "win32" ? "junction" : "dir",
  );

  // OpenCode 1.18.29 checks node_modules and the lockfile's declared names
  // before invoking npm. Describe the actual installed link, so this path
  // never needs a registry or a second copy of its transitive dependencies.
  const target = relative(configDirectory, directory).split(sep).join("/");
  const dependencies = { [name]: `file:${target}` };
  await Promise.all([
    writeFile(
      join(configDirectory, "package.json"),
      JSON.stringify({ private: true, dependencies }),
      { mode: 0o600 },
    ),
    writeFile(
      join(configDirectory, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { dependencies },
          [target]: { name, version, dependencies: installed.dependencies },
          [`node_modules/${name}`]: { resolved: target, link: true },
        },
      }),
      { mode: 0o600 },
    ),
  ]);
}
