/** `@sapiom/mcp/map`: the agent map computed from code, and the source scan Studio's Canvas shares. */
export * from "./source-scan.js";
export * from "./types.js";
export { buildMap, systemId } from "./build.js";
export {
  checkSteps,
  describeProject,
  MapInputError,
  type PlatformSource,
  type ScanOptions,
  type StepSource,
} from "./scan-project.js";
export { accountPlatform } from "./platform.js";
