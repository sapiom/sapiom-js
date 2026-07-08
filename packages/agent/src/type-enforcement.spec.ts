/**
 * TYPE-LEVEL enforcement — the load-bearing claim of the declared-edge model.
 *
 * These assertions are checked by `tsc --noEmit` (the package `typecheck`
 * script), NOT by the test runner's runtime (esbuild erases types). Jest just
 * imports the file; the single runtime `it` keeps the suite non-empty.
 *
 * Two layers:
 *  1. An `Allowed<…>` assignability TABLE — robust, no `@ts-expect-error`
 *     placement fragility: a wrong answer makes `= true/false` fail to compile.
 *  2. `defineStep` smoke checks proving the inference wires `next`/`terminal`/…
 *     through to the `run` return constraint end-to-end.
 */

import { defineStep, fail, goto, pauseUntilSignal, retry, terminate } from './index.js';
import type { Allowed, Goto, Pause, Retry, Terminate } from './index.js';

type Extends<A, B> = A extends B ? true : false;

// ---- 1. Allowed<…> assignability table ----------------------------------

// goto: assignable iff the target ∈ next
const _gotoDeclared: Extends<Goto<'b'>, Allowed<['b'], false, false, never>> = true;
const _gotoUndeclared: Extends<Goto<'c'>, Allowed<['b'], false, false, never>> = false;
// dynamic goto(cond ? 'a' : 'b') — assignable iff BOTH ∈ next
const _gotoUnionOk: Extends<Goto<'a' | 'b'>, Allowed<['a', 'b'], false, false, never>> = true;
const _gotoUnionPartial: Extends<Goto<'a' | 'c'>, Allowed<['a', 'b'], false, false, never>> = false;
// terminate: only when terminal:true
const _terminateNoDecl: Extends<Terminate, Allowed<[], false, false, never>> = false;
const _terminateDecl: Extends<Terminate, Allowed<[], true, false, never>> = true;
// pause: only with a matching resumeStep declaration
const _pauseNoDecl: Extends<Pause<'r'>, Allowed<[], false, false, never>> = false;
const _pauseDecl: Extends<Pause<'r'>, Allowed<[], false, false, 'r'>> = true;
// retry: always allowed
const _retryAlways: Extends<Retry, Allowed<[], false, false, never>> = true;

const TABLE = [
  _gotoDeclared,
  _gotoUndeclared,
  _gotoUnionOk,
  _gotoUnionPartial,
  _terminateNoDecl,
  _terminateDecl,
  _pauseNoDecl,
  _pauseDecl,
  _retryAlways,
];

// ---- 2. defineStep end-to-end inference smoke checks ---------------------
// Never invoked; tsc checks the bodies. Each `@ts-expect-error` asserts the
// constraint fires — an unused directive (i.e. it compiled) is itself a tsc error.

function _smoke() {
  // valid: goto to a declared target
  defineStep({ name: 's', next: ['b'], run: async () => goto('b') });
  // valid: retry is always allowed
  defineStep({ name: 's', next: ['b'], run: async () => retry() });
  // valid: terminate with terminal:true
  defineStep({ name: 's', next: [], terminal: true, run: async () => terminate({ ok: 1 }) });
  // valid: fail with canFail:true
  defineStep({ name: 's', next: [], canFail: true, run: async () => fail('x') });
  // valid: pause with a matching declaration
  defineStep({
    name: 's',
    next: [],
    pause: { signal: 'sig', resumeStep: 'b' },
    run: async () => pauseUntilSignal({ signal: 'sig', resumeStep: 'b' }),
  });

  // INVALID: goto to an undeclared target
  defineStep({
    name: 's',
    next: ['b'],
    run: async () =>
      // @ts-expect-error 'c' is not in next: ['b']
      goto('c'),
  });
  // INVALID: terminate without terminal:true
  defineStep({
    name: 's',
    next: [],
    run: async () =>
      // @ts-expect-error step did not declare terminal: true
      terminate(),
  });
  // INVALID: fail without canFail:true
  defineStep({
    name: 's',
    next: [],
    run: async () =>
      // @ts-expect-error step did not declare canFail: true
      fail('x'),
  });
  // INVALID: pause to an undeclared resumeStep
  defineStep({
    name: 's',
    next: [],
    pause: { signal: 'sig', resumeStep: 'b' },
    run: async () =>
      // @ts-expect-error resumeStep 'c' does not match the declared 'b'
      pauseUntilSignal({ signal: 'sig', resumeStep: 'c' }),
  });
}

describe('type enforcement', () => {
  it('assignability table + defineStep smoke checks are validated by tsc --noEmit', () => {
    expect(TABLE).toHaveLength(9);
    expect(typeof _smoke).toBe('function');
  });
});
