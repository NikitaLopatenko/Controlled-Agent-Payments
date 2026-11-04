import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { prepareRequest, MAX_BODY_BYTES } from '../packages/payments/dist/request.js';
import { abortable, checkAbort } from '../packages/payments/dist/signal.js';
import { PaymentError } from '../packages/payments/dist/errors.js';

const network = 'eip155:84532';
const url = 'https://merchant.example/item?a=1&b=%20';
const prepare = (input = url, init, selectedNetwork = network) => prepareRequest(input, init, selectedNetwork);
const fails = code => error => error instanceof PaymentError && error.code === code && error.paymentState === 'not_attempted';
const bodyBytes = async request => new Uint8Array(await request.arrayBuffer());

test('equivalent byte POSTs have one identity and remain replayable for both transports', async () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255);
  const headers = [['X-Z', ' last '], ['Content-Type', 'application/octet-stream'], ['X-A', 'first']];
  const first = await prepare(url, { method: 'post', headers, body: bytes, redirect: 'follow' });
  const second = await prepare(new Request(url, {
    method: 'POST', body: new Blob([bytes]),
    headers: { 'x-a': 'first', 'content-type': 'application/octet-stream', 'x-z': 'last' },
  }));
  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.match(first.requestFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.targetOrigin, 'https://merchant.example');
  assert.equal(first.request.url, url);
  assert.equal(first.request.method, 'POST');
  assert.equal(first.request.redirect, 'error');
  assert.equal(first.request.bodyUsed, false);
  assert.deepEqual(await bodyBytes(first.request.clone()), bytes);
  const paidHeaders = new Headers(first.request.headers);
  paidHeaders.set('PAYMENT-SIGNATURE', 'in-flight-only');
  const paid = new Request(first.request, { headers: paidHeaders, redirect: 'error' });
  assert.equal(paid.redirect, 'error');
  assert.deepEqual(await bodyBytes(paid), bytes);
  assert.deepEqual(await bodyBytes(second.request), bytes);
});

test('method, exact URL/query, effective headers and bytes each bind the fingerprint', async () => {
  const init = { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-choice': 'one' }, body: Uint8Array.of(1, 2) };
  const baseline = (await prepare(url, init)).requestFingerprint;
  const variants = [
    [url.replace('a=1&b=%20', 'b=%20&a=1'), init],
    [url.replace('b=%20', 'b=+'), init],
    [url.replace('/item?', '/other?'), init],
    [url, { ...init, method: 'PUT' }],
    [url, { ...init, headers: { ...init.headers, 'x-choice': 'two' } }],
    [url, { ...init, body: Uint8Array.of(1, 3) }],
  ];
  for (const [input, options] of variants) {
    assert.notEqual((await prepare(input, options)).requestFingerprint, baseline);
  }
  assert.notEqual((await prepare(url)).requestFingerprint, (await prepare(url, { method: 'HEAD' })).requestFingerprint);
  const source = new Request(url, { headers: { 'x-choice': 'hidden-by-override' } });
  const overridden = await prepare(source, { headers: { 'x-choice': 'effective' } });
  const effective = await prepare(url, { headers: { 'x-choice': 'effective' } });
  assert.equal(overridden.requestFingerprint, effective.requestFingerprint);
});

test('URL, init, original headers and resident body storage are captured before awaits', async () => {
  const mutableUrl = new URL(url);
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'x-choice': 'captured' });
  const bytes = Uint8Array.of(1, 2, 3);
  const init = { method: 'POST', headers, body: bytes };
  const pending = prepare(mutableUrl, init);
  mutableUrl.search = '?changed=true';
  headers.set('x-choice', 'changed');
  bytes.fill(9);
  init.method = 'PUT';
  init.body = Uint8Array.of(7);
  const captured = await pending;
  const expected = await prepare(url, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-choice': 'captured' }, body: Uint8Array.of(1, 2, 3),
  });
  assert.equal(captured.requestFingerprint, expected.requestFingerprint);
  assert.deepEqual(await bodyBytes(captured.request), Uint8Array.of(1, 2, 3));

  const original = new Request(url, { headers: { 'x-choice': 'original' } });
  const originalPending = prepare(original);
  original.headers.set('x-choice', 'changed');
  assert.equal((await originalPending).request.headers.get('x-choice'), 'original');
});

test('original and overriding payment headers are rejected even when hidden by an override', async () => {
  for (const name of ['PAYMENT-SIGNATURE', 'x-payment']) {
    const original = new Request(url, { headers: { [name]: 'private-proof' } });
    await assert.rejects(prepare(original, { headers: { 'x-ordinary': 'safe' } }), fails('payment_already_supplied'));
    await assert.rejects(prepare(url, { headers: [[name, 'private-proof']] }), fails('payment_already_supplied'));
    await assert.rejects(prepare(new Request(url), { headers: new Headers({ [name]: 'private-proof' }) }), fails('payment_already_supplied'));
  }
});

test('consumed or locked original bodies cannot be replaced to evade replay checks', async () => {
  const consumed = new Request(url, { method: 'POST', body: 'original' });
  await consumed.text();
  await assert.rejects(prepare(consumed), fails('request_not_replayable'));
  await assert.rejects(prepare(consumed, { body: 'replacement' }), fails('request_not_replayable'));
  const locked = new Request(url, { method: 'POST', body: 'original' });
  const reader = locked.body.getReader();
  try {
    await assert.rejects(prepare(locked, { body: 'replacement' }), fails('request_not_replayable'));
  } finally {
    reader.releaseLock();
  }
});

test('caller init streams and async iterables are rejected without starting them', async () => {
  let pulls = 0;
  const stream = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  const iterable = { async *[Symbol.asyncIterator]() { pulls++; yield Uint8Array.of(1); } };
  await assert.rejects(prepare(url, { method: 'POST', body: stream, duplex: 'half' }), fails('request_not_replayable'));
  await assert.rejects(prepare(url, { method: 'POST', body: iterable, duplex: 'half' }), fails('request_not_replayable'));
  assert.equal(pulls, 0);
});

test('exactly 1 MiB is replayable but larger byte or UTF-8 bodies are rejected', async () => {
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  bytes[0] = 17;
  bytes[bytes.length - 1] = 93;
  const exact = await prepare(url, { method: 'POST', body: bytes });
  assert.deepEqual(await bodyBytes(exact.request.clone()), bytes);
  assert.deepEqual(await bodyBytes(exact.request), bytes);
  await assert.rejects(prepare(url, { method: 'POST', body: new Uint8Array(MAX_BODY_BYTES + 1) }), fails('request_not_replayable'));
  await assert.rejects(prepare(url, { method: 'POST', body: 'é'.repeat(MAX_BODY_BYTES / 2 + 1) }), fails('request_not_replayable'));
});

test('Request-stream chunks are owned before a producer reuses its storage', async () => {
  const shared = new Uint8Array(2);
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index === 2) { controller.close(); return; }
      shared.set(index++ === 0 ? [1, 2] : [3, 4]);
      controller.enqueue(shared);
    },
  }, { highWaterMark: 0 });
  const input = new Request(url, { method: 'POST', body: stream, duplex: 'half' });
  const actual = await prepare(input);
  shared.fill(9);
  const expected = await prepare(url, { method: 'POST', body: Uint8Array.of(1, 2, 3, 4) });
  assert.equal(actual.requestFingerprint, expected.requestFingerprint);
  assert.deepEqual(await bodyBytes(actual.request), Uint8Array.of(1, 2, 3, 4));
});

test('the streaming limit is cumulative and cancellation does not await the producer', { timeout: 2000 }, async () => {
  let index = 0, cancellations = 0;
  const forever = Promise.withResolvers().promise;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(index++ === 0 ? MAX_BODY_BYTES : 1)); },
    cancel() { cancellations++; return forever; },
  }, { highWaterMark: 0 });
  await assert.rejects(prepare(new Request(url, { method: 'POST', body: stream, duplex: 'half' })), fails('request_not_replayable'));
  await nextTurn();
  assert.equal(cancellations, 1);
});

test('body read failures expose only a fixed safe request error', async () => {
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error('private-body-token')); } }, { highWaterMark: 0 });
  await assert.rejects(prepare(new Request(url, { method: 'POST', body: stream, duplex: 'half' })), error => {
    assert.equal(error.code, 'request_not_replayable');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private-body-token/);
    return true;
  });
});

test('credentials, all fragments and noncanonical transport origins fail closed', async () => {
  for (const input of ['https://user:private@merchant.example/item', url + '#', url + '#fragment', 'http://merchant.example/item', 'file:///tmp/item', '/relative']) {
    await assert.rejects(prepare(input), fails('invalid_config'));
  }
  for (const origin of ['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) {
    assert.equal((await prepare(origin + '/item')).targetOrigin, origin);
    await assert.rejects(prepare(origin + '/item', undefined, 'eip155:8453'), fails('invalid_config'));
  }
  await assert.rejects(prepare('http://localhost.example/item'), fails('invalid_config'));
  const canonical = await prepare('https://MERCHANT.EXAMPLE:443/item');
  assert.equal(canonical.targetOrigin, 'https://merchant.example');
  assert.equal(canonical.request.url, 'https://merchant.example/item');
});

test('pre-aborted effective signals reject, while explicit signal overrides are respected', async () => {
  const aborted = new AbortController();
  aborted.abort('private-abort-reason');
  await assert.rejects(prepare(url, { signal: aborted.signal }), fails('request_aborted'));
  const original = new Request(url, { signal: aborted.signal });
  await assert.rejects(prepare(original), fails('request_aborted'));
  const active = new AbortController();
  assert.equal((await prepare(original, { signal: active.signal })).request.signal.aborted, false);
  assert.equal((await prepare(original, { signal: null })).request.signal.aborted, false);
  let reads = 0;
  const init = { get signal() { reads++; return active.signal; } };
  await prepare(url, init);
  assert.equal(reads, 1);
});

test('abort interrupts a stalled Request reader even when cancellation never completes', { timeout: 2000 }, async () => {
  const entered = Promise.withResolvers();
  const forever = Promise.withResolvers().promise;
  const controller = new AbortController();
  let cancellations = 0;
  const stream = new ReadableStream({
    pull() { entered.resolve(); return forever; },
    cancel() { cancellations++; return forever; },
  }, { highWaterMark: 0 });
  const input = new Request(url, { method: 'POST', body: stream, duplex: 'half', signal: controller.signal });
  const pending = prepare(input);
  const rejected = assert.rejects(pending, fails('request_aborted'));
  await entered.promise;
  controller.abort('private-reason');
  await rejected;
  await nextTurn();
  assert.equal(cancellations, 1);
});

test('hash awaits honor abort and a late digest cannot resume preparation', { timeout: 2000 }, async t => {
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis.crypto.subtle, 'digest', () => { calls++; return gate.promise; });
  const pending = prepare(url, { signal: controller.signal });
  const rejected = assert.rejects(pending, fails('request_aborted'));
  assert.equal(calls, 1);
  controller.abort();
  await rejected;
  gate.resolve(new ArrayBuffer(32));
  await nextTurn();
  assert.equal(calls, 1);
});

test('throwing init getters are sanitized without retaining the host exception', async () => {
  await assert.rejects(prepare(url, { get signal() { throw new Error('private-config-token'); } }), error => {
    assert.equal(error.code, 'request_not_replayable');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private-config-token/);
    return true;
  });
});

test('abort helpers check before calling and never retain a caller reason', async () => {
  checkAbort();
  checkAbort(null);
  const controller = new AbortController();
  controller.abort(new Error('private-reason'));
  assert.throws(() => checkAbort(controller.signal), fails('request_aborted'));
  let calls = 0;
  await assert.rejects(abortable(() => { calls++; }, controller.signal), fails('request_aborted'));
  assert.equal(calls, 0);
  let synchronous = false;
  const result = abortable(() => { synchronous = true; return 7; });
  assert.equal(synchronous, true);
  assert.equal(await result, 7);
});

test('abortable cleans listeners on success and synchronous failure', async () => {
  const controller = new AbortController();
  const baseline = getEventListeners(controller.signal, 'abort').length;
  assert.equal(await abortable(() => 7, controller.signal), 7);
  assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
  const failure = new Error('host-failure');
  await assert.rejects(abortable(() => { throw failure; }, controller.signal), error => error === failure);
  assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
});

test('abortable rejects promptly, observes late rejection and never resumes the caller', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  let continuations = 0;
  const pending = abortable(() => gate.promise, controller.signal).then(() => { continuations++; });
  const rejected = assert.rejects(pending, fails('request_aborted'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  gate.reject(new Error('private-late-failure'));
  await nextTurn();
  assert.equal(continuations, 0);
});

test('abortable rechecks abort after a resolved callback before returning its result', async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  const pending = abortable(() => gate.promise, controller.signal);
  const rejected = assert.rejects(pending, fails('request_aborted'));
  gate.resolve('must-not-return');
  queueMicrotask(() => controller.abort());
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  const synchronous = new AbortController();
  await assert.rejects(abortable(() => {
    synchronous.abort();
    throw new Error('private-synchronous-failure');
  }, synchronous.signal), fails('request_aborted'));
  await nextTurn();
});

test('a callback that fulfills after cancellation cannot resume its awaiting caller', async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  let resumed = false;
  const pending = abortable(() => gate.promise, controller.signal).then(() => { resumed = true; });
  const rejected = assert.rejects(pending, fails('request_aborted'));
  controller.abort();
  await rejected;
  gate.resolve('late-result');
  await nextTurn();
  assert.equal(resumed, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
