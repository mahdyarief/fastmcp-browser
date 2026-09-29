import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapScriptResult } from '../src/script-result.js';

test('surfaces the page error instead of reporting no result', () => {
  assert.throws(
    () => unwrapScriptResult([{ error: { message: 'Unsupported pointer type: pointerdown', code: 'INVALID_ARGUMENT' } }], 'browser_pointer_drag'),
    error => error.message.includes('Unsupported pointer type: pointerdown') && error.code === 'INVALID_ARGUMENT'
  );
});

test('surfaces a bare string error from the injected function', () => {
  assert.throws(
    () => unwrapScriptResult([{ error: 'Page engine unavailable' }], 'browser_snapshot'),
    error => error.message.includes('Page engine unavailable') && error.code === 'PAGE_ERROR'
  );
});

test('returns the injected value when present', () => {
  assert.deepEqual(unwrapScriptResult([{ result: { ok: true } }], 'browser_snapshot'), { ok: true });
  assert.equal(unwrapScriptResult([{ result: false }], 'browser_click'), false);
});

test('reports a missing value as null so the caller can retry reads', () => {
  assert.equal(unwrapScriptResult([{ result: undefined }], 'browser_snapshot'), null);
  assert.equal(unwrapScriptResult([], 'browser_snapshot'), null);
  assert.equal(unwrapScriptResult(undefined, 'browser_snapshot'), null);
});
