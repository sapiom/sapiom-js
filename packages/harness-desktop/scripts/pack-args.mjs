// Validates pack.mjs's argv: [platform flag] [...electron-builder args].
//
// Both lists are allowlists. electron-builder's yargs also accepts other
// spellings of the platform (`--macos`, `-m`, `-o`) and of the publish flag
// (`-p`, grouped short options, repeats). Any of them would let a mac build skip
// the update-manifest stamp, or upload latest-mac.yml before it is stamped
// (src/main/mac-minimum.ts), so only the spellings pack.mjs understands get through.
export const PLATFORM_FLAGS = ["--linux", "--mac", "--win"];
const CONFIG_OVERRIDE = /^(?:-c|--config)\.[A-Za-z]/;

export function parsePackArgs(argv, hostPlatformFlag) {
  // Empty strings dropped: a shell passing an unset flag as "" would otherwise
  // reach electron-builder as a bogus empty argument.
  const [platform = hostPlatformFlag, ...passthrough] = argv.filter((arg) => arg.length > 0);
  if (!PLATFORM_FLAGS.includes(platform)) {
    throw new Error(`pack.mjs: the platform must be one of ${PLATFORM_FLAGS.join(", ")} (got ${platform})`);
  }
  const rejected = passthrough.filter((arg) => !CONFIG_OVERRIDE.test(arg));
  if (rejected.length > 0) {
    throw new Error(
      `pack.mjs: only -c.<key> overrides pass through to electron-builder (got ${rejected.join(" ")})`,
    );
  }
  return { platform, passthrough };
}
