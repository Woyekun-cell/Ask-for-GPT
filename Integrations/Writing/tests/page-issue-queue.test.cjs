const test = require('node:test');
const assert = require('node:assert/strict');
const queueModule = import('../shared/page-issue-queue.js').catch(() => ({}));

function snapshot(id = 'a', overrides = {}) {
  return { requestID: `req-${id}`, documentSessionID: 'doc', blockID: id, revision: '1', rawText: 'teh word is bad.', snapshotHash: `hash-${id}`, contextHash: 'context', contextBefore: '', contextAfter: '', targetRange: {start: 0, length: 16}, protectedRanges: [], pageIndices: [1], scope: 'visiblePages', ...overrides };
}
function issue(id, start = 0, category = 'spelling') {
  return { id, category, original: 'teh', replacement: 'the', reason: '拼写', range: {start, length: 3}, requiresAuthorConfirmation: false };
}
function result(s, issues, overrides = {}) {
  return {requestID: s.requestID, snapshotHash: s.snapshotHash, skillVersion: 'local-1', status: 'completed', issues, ...overrides};
}
async function makeQueue() {
  const {PageIssueQueue} = await queueModule;
  assert.equal(typeof PageIssueQueue, 'function', 'PageIssueQueue must implement the shared queue');
  return new PageIssueQueue();
}

test('unchecked scope stays unchecked until a completed result, and failed results never become clean', async () => {
  const q = await makeQueue(), s = snapshot();
  q.updateScope({scope: 'visiblePages', pageIndices: [1], snapshots: [s]});
  assert.equal(q.state.checked, false);
  assert.equal(q.state.status, 'unchecked');
  assert.equal(q.acceptResult(result(s, [], {status: 'failed'})), false);
  assert.equal(q.state.checked, false);
  assert.equal(q.acceptResult(result(s, [])), true);
  assert.equal(q.state.checked, true);
  assert.equal(q.state.status, 'clean');
});

test('local spelling appears immediately and completed polish merges without erasing it', async () => {
  const q = await makeQueue(), s = snapshot();
  q.updateScope({scope: 'visiblePages', pageIndices: [1], snapshots: [s]});
  q.registerRequest(s, 'spelling');
  q.acceptResult(result(s, [issue('local')]));
  const polish = {...s, requestID: 'polish-a'};
  q.registerRequest(polish, 'polish');
  assert.deepEqual(q.issues.map(e => e.issue.id), ['local']);
  q.acceptResult(result(polish, [issue('style', 12, 'expression')], {skillVersion: 'writing-1'}));
  assert.deepEqual(q.issues.map(e => e.issue.id), ['local', 'style']);
});

test('issues follow page and original paragraph order, with within-paragraph offsets', async () => {
  const q = await makeQueue(), a = snapshot('a'), b = snapshot('b'), c = snapshot('c', {pageIndices: [2]});
  q.updateScope({scope: 'visiblePages', pageIndices: [1, 2], snapshots: [a, b, c]});
  q.acceptResult(result(c, [issue('c')])); q.acceptResult(result(b, [issue('b')]));
  q.acceptResult(result(a, [issue('a-late', 12), issue('a-first')]));
  assert.deepEqual(q.issues.map(e => e.issue.id), ['a-first', 'a-late', 'b', 'c']);
  assert.equal(q.current.issue.id, 'a-first');
  assert.equal(q.next().issue.id, 'a-late');
  assert.equal(q.previous().issue.id, 'a-first');
});

test('cross-page paragraph deduplicates one issue, and repagination preserves its raw anchor', async () => {
  const q = await makeQueue(), a = snapshot('a', {pageIndices: [1, 2]});
  q.updateScope({scope: 'visiblePages', pageIndices: [1, 2], snapshots: [a, {...a, pageIndices: [2]}]});
  q.acceptResult(result(a, [issue('a')]));
  assert.equal(q.issues.length, 1);
  q.updateScope({scope: 'visiblePages', pageIndices: [3], snapshots: [{...a, pageIndices: [3]}]});
  assert.equal(q.issues.length, 1);
  assert.deepEqual(q.current.snapshot.pageIndices, [3]);
  assert.equal(q.current.snapshot.rawText, 'teh word is bad.');
  assert.equal(q.current.snapshot.blockID, 'a');
});

test('page switches, edits, context changes and superseded requests reject stale responses', async () => {
  for (const change of [snapshot('b'), snapshot('a', {revision: '2', snapshotHash: 'new'}), snapshot('a', {contextHash: 'new-context'})]) {
    const q = await makeQueue(), a = snapshot();
    q.updateScope({scope: 'visiblePages', pageIndices: [1], snapshots: [a]});
    q.updateScope({scope: 'visiblePages', pageIndices: [2], snapshots: [change]});
    assert.equal(q.acceptResult(result(a, [issue('old')])), false);
    assert.equal(q.issues.length, 0);
  }
  const q = await makeQueue(), a = snapshot();
  q.updateScope({scope: 'visiblePages', pageIndices: [1], snapshots: [a]});
  q.registerRequest(a, 'polish');
  q.registerRequest({...a, requestID: 'new-request'}, 'polish');
  assert.equal(q.acceptResult(result(a, [issue('old')])), false);
  assert.equal(q.acceptResult(result({...a, requestID: 'new-request'}, [], {snapshotHash: 'wrong'})), false);
});

test('invalidating an accepted paragraph removes all old offsets and advances to next paragraph', async () => {
  const q = await makeQueue(), a = snapshot(), b = snapshot('b');
  q.updateScope({scope: 'visiblePages', pageIndices: [1], snapshots: [a, b]});
  q.acceptResult(result(a, [issue('a'), issue('a-next', 12)]));
  q.acceptResult(result(b, [issue('b')]));
  q.invalidate('a');
  assert.equal(q.current.issue.id, 'b');
  assert.equal(q.acceptResult(result(a, [issue('stale')])), false);
  q.dispose();
  assert.equal(q.acceptResult(result(b, [issue('disposed')])), false);
  assert.equal(q.current, null);
});

test('issue physical pages regroup display without altering paragraph anchor or duplicating cross-page issues', async () => {
  const q = await makeQueue(), a = snapshot('a', {pageIndices: [1,2]}), b = snapshot('b', {pageIndices: [1]});
  q.updateScope({scope:'visiblePages',pageIndices:[1,2],snapshots:[a,b]});
  q.acceptResult(result(a,[issue('a')])); q.acceptResult(result(b,[issue('b')]));
  const aEnvelope = q.issues.find(e=>e.issue.id==='a');
  assert.deepEqual(q.pagesFor(aEnvelope), []);
  q.setIssuePages(aEnvelope,[2]);
  assert.deepEqual(q.issues.map(e=>e.issue.id), ['b','a']);
  assert.deepEqual(q.pagesFor(q.issues[1]), [2]);
  assert.deepEqual(q.issues[1].snapshot.pageIndices, [1,2]);
});

test('I5 no-candidate spelling and context questions remain visible while no-op expression is filtered', async () => {
  const q=await makeQueue(), a=snapshot();
  q.updateScope({scope:'visiblePages',pageIndices:[1],snapshots:[a]});
  q.acceptResult(result(a,[
    {...issue('spell'),replacement:'teh'},
    {...issue('style',0,'expression'),replacement:'teh'},
    {...issue('blank',0,'context'),replacement:'teh',reason:'  '},
    {...issue('question',0,'context'),replacement:'teh',reason:'请补充比较对象。',requiresAuthorConfirmation:true}
  ]));
  assert.deepEqual(q.issues.map(e=>e.issue.id),['spell','question']);
  assert.equal(q.state.status,'issues');
});

module.exports = {snapshot, issue, result};
