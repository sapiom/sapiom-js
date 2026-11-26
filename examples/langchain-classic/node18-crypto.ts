// langsmith 0.6+ reads the global `crypto`, which Node 18 does not define.
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto as typeof globalThis.crypto;
