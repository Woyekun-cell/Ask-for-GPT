const assert = require('node:assert/strict');
const test = require('node:test');
const {createHmac, webcrypto} = require('node:crypto');
const Shortcut = require('../content/ask-paper-shortcut.js');
const route = '/askgpt/paper';
const token = 'fixture-' + 't'.repeat(56);

function fixture(result = 'ok') {
  let now = 1783500000000, reads = 0;
  const opens = [], window = {crypto: webcrypto};
  const endpoints = {};
  const Zotero = {Server: {Endpoints: endpoints}, getMainWindow: () => window};
  const connection = {token, url: 'http://127.0.0.1:43792/v1/inline/translate'};
  const dependencies = {
    Zotero, Services: {focus: {activeWindow: window}}, now: () => now,
    readConnection: async () => { reads++; return connection; },
    open: async (nonce, pair) => { assert.equal(pair, connection); opens.push(nonce); return result; }
  };
  const dispose = Shortcut.register(dependencies);
  function request(nonce = '1'.repeat(32), timestamp = String(now)) {
    return {
      method: 'POST', pathname: route, searchParams: new URLSearchParams(), data: {},
      headers: {host: '127.0.0.1:23119', 'content-type': 'application/json', 'content-length': '2',
        'x-askgpt-timestamp': timestamp, 'x-askgpt-nonce': nonce,
        'x-askgpt-proof': createHmac('sha256', token).update('askgpt-paper-v1\n' + timestamp + '\n' + nonce).digest('hex')}
    };
  }
  return {dispose, dependencies, endpoints, opens, request,
    call: async (req = request()) => new endpoints[route]().init(req),
    get reads() { return reads; }, advance: milliseconds => { now += milliseconds; }};
}

test('signed native request opens one local handoff and the same proof cannot replay', async () => {
  const f = fixture(), request = f.request();
  const replies = await Promise.all([f.call(request), f.call(request)]);
  assert.deepEqual(replies.map(row => row[0]).sort(), [200, 409]);
  const success = replies.find(row => row[0] === 200);
  assert.deepEqual(JSON.parse(success[2]), {ok: true});
  assert.equal(success[1]['Cache-Control'], 'no-store');
  assert.deepEqual(f.opens, ['1'.repeat(32)]);
  assert(!JSON.stringify(replies).includes(token));
});

test('expired, wrong proof, browser origin, query, body and host never request paper context', async () => {
  const f = fixture();
  const expired = f.request();f.advance(10001);
  const wrong = f.request();wrong.headers['x-askgpt-proof'] = 'f'.repeat(64);
  const origin = f.request();origin.headers.origin = '';
  const host = f.request();host.headers.host = 'localhost:23119';
  const query = f.request();query.searchParams.set('item', 'ATTACH01');
  const body = f.request();body.data = {item: 'ATTACH01'};
  const bearer = f.request();bearer.headers.authorization = 'Bearer ' + token;
  for (const request of [expired, wrong, origin, host, query, body, bearer]) {
    assert.equal((await f.call(request))[0], 403);
  }
  assert.equal(f.opens.length, 0);
  assert.equal(f.reads, 1, 'only the shaped wrong HMAC needs the protected token');
});

test('no reader and stale handoff return fixed statuses without document content', async () => {
  for (const [result, status] of [['no_reader', 404], ['stopped', 409], ['busy', 409], ['unavailable', 503]]) {
    const f = fixture(result);
    const response = await f.call();
    assert.equal(response[0], status);
    assert.deepEqual(JSON.parse(response[2]), {ok: false});
  }
});

test('registration never overwrites or removes another endpoint owner', () => {
  const f = fixture();
  const installed = f.endpoints[route];
  const duplicateDispose = Shortcut.register(f.dependencies);
  assert.equal(f.endpoints[route], installed);
  duplicateDispose();
  assert.equal(f.endpoints[route], installed);
  const newer = function () {};
  f.endpoints[route] = newer;
  f.dispose();
  assert.equal(f.endpoints[route], newer);
  delete f.endpoints[route];
  Shortcut.register(f.dependencies)();
  assert.equal(f.endpoints[route], undefined);
});
