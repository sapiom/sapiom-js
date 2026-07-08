/**
 * validateGraph — build-time conformance over the manifest's transitions.
 */

import { assertValidGraph, buildManifest, validateGraph } from './build-manifest.js';
import { goto, pauseUntilSignal, terminate } from './directives.js';
import { defineStep } from './step.js';
import { defineAgent } from './agent.js';

const ARTIFACT = { sha256: 'x', entryFile: 'f.mjs' };
const manifestOf = (def: Parameters<typeof buildManifest>[0]) =>
  buildManifest(def, { sdkVersion: '0.1.0', artifact: ARTIFACT });

describe('validateGraph', () => {
  it('passes a well-formed linear graph', () => {
    const def = defineAgent({
      name: 'ok',
      entry: 'a',
      steps: {
        a: defineStep({
          name: 'a',
          next: ['b'],
          async run() {
            return goto('b');
          },
        }),
        b: defineStep({
          name: 'b',
          next: [],
          terminal: true,
          async run() {
            return terminate(null);
          },
        }),
      },
    });
    const { errors, warnings } = validateGraph(manifestOf(def));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('errors on a continue target that does not exist', () => {
    // Build a manifest then tamper to simulate an over-declared/garbage target
    // (defineStep itself cannot express a non-string target; the engine/build
    // guard against manifests, so we validate at the manifest layer).
    const manifest = {
      protocol: 1 as const,
      name: 'bad',
      entry: 'a',
      sdkVersion: '0.1.0',
      artifact: ARTIFACT,
      steps: {
        a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue' as const, target: 'ghost' }] },
      },
    };
    const { errors } = validateGraph(manifest);
    expect(errors.some((e) => e.includes("'ghost'"))).toBe(true);
  });

  it('errors on a dead-end step (no transitions at all)', () => {
    const manifest = {
      protocol: 1 as const,
      name: 'dead',
      entry: 'a',
      sdkVersion: '0.1.0',
      artifact: ARTIFACT,
      steps: { a: { timeoutMs: null, inputSchema: null, transitions: [] } },
    };
    const { errors } = validateGraph(manifest);
    expect(errors.some((e) => e.includes('dead-end'))).toBe(true);
  });

  it('warns on an unreachable step', () => {
    const def = defineAgent({
      name: 'island',
      entry: 'a',
      steps: {
        a: defineStep({
          name: 'a',
          next: [],
          terminal: true,
          async run() {
            return terminate(null);
          },
        }),
        orphan: defineStep({
          name: 'orphan',
          next: [],
          terminal: true,
          async run() {
            return terminate(null);
          },
        }),
      },
    });
    const { errors, warnings } = validateGraph(manifestOf(def));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("'orphan'") && w.includes('unreachable'))).toBe(true);
  });

  it('warns when a step cannot reach any terminal (unbounded loop)', () => {
    // a <-> b continue loop, no terminate anywhere.
    const manifest = {
      protocol: 1 as const,
      name: 'loop',
      entry: 'a',
      sdkVersion: '0.1.0',
      artifact: ARTIFACT,
      steps: {
        a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue' as const, target: 'b' }] },
        b: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'continue' as const, target: 'a' }] },
      },
    };
    const { warnings } = validateGraph(manifest);
    expect(warnings.some((w) => w.includes('unbounded') || w.includes('no step can terminate'))).toBe(true);
  });

  it('accepts a pause self-loop reaching a terminal (the repo-lock barrier shape)', () => {
    const def = defineAgent({
      name: 'barrier',
      entry: 'await_lock',
      steps: {
        await_lock: defineStep({
          name: 'await_lock',
          next: ['provision'],
          canFail: true,
          pause: { signal: 'repo-free', resumeStep: 'await_lock' },
          async run() {
            return pauseUntilSignal({ signal: 'repo-free', resumeStep: 'await_lock' });
          },
        }),
        provision: defineStep({
          name: 'provision',
          next: [],
          terminal: true,
          async run() {
            return terminate(null);
          },
        }),
      },
    });
    const { errors, warnings } = validateGraph(manifestOf(def));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('assertValidGraph throws on errors and returns warnings otherwise', () => {
    const bad = {
      protocol: 1 as const,
      name: 'x',
      entry: 'missing',
      sdkVersion: '0.1.0',
      artifact: ARTIFACT,
      steps: { a: { timeoutMs: null, inputSchema: null, transitions: [{ kind: 'terminate' as const }] } },
    };
    expect(() => assertValidGraph(bad)).toThrow(/Invalid workflow graph/);
  });
});
