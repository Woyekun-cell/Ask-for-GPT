'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {randomUUID} = require('node:crypto');
const {Document, Window} = require('./fake-dom.cjs');
const PaperChat = require('../content/paper-chat-panel.js');

const tick = () => new Promise(setImmediate);
const json = (value, status = 200) => ({status, responseText: JSON.stringify(value)});
const source = (page, index, quote) => ({page, marker: 'p' + page + '.' + index, quote});
const reply = (attachmentID, extra = {}) => ({
  title: 'Fixture ' + attachmentID, attachmentID, model: 'Test model', scope: 'nearby',
  messages: [], isSending: false, ...extra
});

function fixture({attachmentID = '1:FIRST001', respond = () => reply(attachmentID), request} = {}) {
  const doc = new Document(), clientID = randomUUID(), calls = [], reads = [];
  let page = 0, timerID = 0;
  const timers = new Map();
  const dock = PaperChat.mount({doc, clientID, chinese: false,
    request: async (message, options) => {
      calls.push(message);
      return request ? request(message, options) : respond(message);
    },
    extract: async inputs => {
      reads.push(inputs);
      return {attachmentID, currentPage: inputs.page + 1, selection: inputs.selection?.text || ''};
    },
    readInputs: () => ({page}),
    isCurrent: () => true,
    setTimer(fn) { timers.set(++timerID, fn); return timerID; },
    clearTimer(id) { timers.delete(id); }
  });
  const nodes = doc.body.allNodes.bind(doc.body);
  const button = label => nodes().find(node => node.tagName === 'button' && node.getAttribute('aria-label') === label);
  const input = nodes().find(node => node.tagName === 'textarea');
  const transcript = nodes().find(node => node.getAttribute('role') === 'log');
  function submit(question) {
    input.value = question;
    input.emit('input');
    nodes().find(node => node.tagName === 'form').emit('submit');
  }
  return {doc, dock, calls, reads, clientID, button, input, transcript, submit, timers,
    setPage(value) { page = value; }};
}

test('paper A and B keep separate docs, drafts, reading scroll and collapsed state across tabs', async () => {
  const a = fixture(), b = fixture({attachmentID: '1:SECOND02'});
  try {
    assert.equal(a.dock.opened, false);
    assert.equal(b.dock.opened, false);
    assert.equal(a.calls.length + b.calls.length, 0);
    a.dock.show({page: 0, selection: {pageIndex: 0, text: 'Paper A passage'}});
    await tick();
    a.input.value = 'An unfinished A draft';
    Object.assign(a.transcript, {scrollTop: 24, scrollHeight: 800, clientHeight: 120});
    a.dock.setActive(false);
    b.dock.show({page: 3});
    await tick();
    b.input.value = 'A separate B draft';
    b.button('Minimize paper chat').emit('click');
    b.dock.setActive(false);
    a.dock.setActive(true);
    await tick();
    assert.equal(a.dock.opened, true);
    assert.equal(b.dock.opened, false);
    assert.equal(a.transcript.scrollTop, 24);
    assert.equal(a.input.value, 'An unfinished A draft');
    assert.equal(b.input.value, 'A separate B draft');
    assert.equal(a.dock.panel.ownerDocument, a.doc);
    assert.equal(b.dock.panel.ownerDocument, b.doc);
    assert.notEqual(a.clientID, b.clientID);
    assert.equal(a.reads.length, 1, 'switching back does not re-extract a paper');
    assert.equal(a.calls.at(-1).action, 'state');
    a.dock.setActive(false);
    b.dock.setActive(true);
    assert.equal(b.dock.opened, false, 'tab selection respects an already collapsed dock');
    assert.equal(b.calls.length, 1, 'collapsed tab does not poll');
  } finally { a.dock.dispose(); b.dock.dispose(); }
});

test('a repeated PDF page is one disclosure with distinct exact passage targets', async () => {
  const id = randomUUID(), sources = [source(10, 2, 'First exact passage'), source(10, 3, 'Second exact passage'),
    source(10, 2, 'Duplicate same marker'), source(11, 1, 'A different page')];
  const state = reply('1:FIRST001', {messages: [{id, role: 'assistant', text: '<img src=x> Result', completed: true, sources}]});
  const f = fixture({respond: message => message.action === 'jump' ? {...state, precision: 'page'} : state});
  try {
    f.dock.show({page: 9});
    await tick();
    const nodes = f.transcript.allNodes();
    assert.equal(nodes.filter(node => node.tagName === 'summary' && node.textContent === 'PDF p. 10').length, 1);
    assert.equal(nodes.filter(node => node.tagName === 'button' && node.textContent === 'PDF p. 11').length, 1);
    assert.equal(nodes.filter(node => node.tagName === 'button' && node.textContent === 'Duplicate same marker').length, 0);
    assert.equal(nodes.filter(node => node.tagName === 'img').length, 0, 'response HTML remains literal');
    nodes.find(node => node.tagName === 'button' && node.textContent === 'Second exact passage').emit('click');
    await tick();
    assert.deepEqual(f.calls.at(-1), {action: 'jump', clientID: f.clientID, messageID: id, marker: 'p10.3'});
    assert.match(f.dock.panel.textContent, /exact passage could not be located/);
  } finally { f.dock.dispose(); }
});

test('verified evidence follows each claim and adjacent same-page references are grouped', async () => {
  const id = randomUUID();
  const markedText = '**第一条结论。**[[p10.2]], [[p10.2]]、[[p10.3]] Then a *second claim.* [[p11.1]]\n' +
    'Another claim uses the first source. [[p10.2]] <img src=x onerror=fail()> [[p99.1]]';
  const state = reply('1:FIRST001', {messages: [{
    id, role: 'assistant', completed: true, markedText,
    text: '**第一条结论。** Then a *second claim.* \nAnother claim uses the first source. <img src=x onerror=fail()> ',
    sources: [source(10, 2, 'First exact passage'), source(10, 3, 'Second exact passage'), source(11, 1, 'Third exact passage')],
  }]});
  const f = fixture({respond: () => state});
  try {
    f.dock.show({page: 9});
    await tick();
    const body = f.transcript.allNodes().find(node => node.className === 'askgpt-chat-text');
    const nodes = body.allNodes();
    assert.deepEqual(nodes.filter(node => node.tagName === 'strong').map(node => node.textContent), ['第一条结论。']);
    assert.deepEqual(nodes.filter(node => node.tagName === 'em').map(node => node.textContent), ['second claim.']);
    assert.match(body.textContent, /第一条结论。PDF p\. 10 \[1\]\[2\] Then a second claim\. PDF p\. 11\n/);
    assert.match(body.textContent, /Another claim uses the first source\. PDF p\. 10 <img/);
    const groups = nodes.filter(node => node.className === 'askgpt-inline-citation');
    assert.deepEqual(groups.map(node => node.textContent), ['PDF p. 10 [1][2]', 'PDF p. 11', 'PDF p. 10']);
    const firstPageButtons = groups[0].allNodes().filter(node => node.tagName === 'button');
    assert.equal(firstPageButtons.length, 2);
    assert.match(firstPageButtons[0].getAttribute('aria-label'), /First exact passage$/);
    assert.equal(nodes.some(node => node.tagName === 'img'), false);
    assert.doesNotMatch(body.textContent, /\[\[p|PDF p\. 99/);
    assert.equal(f.transcript.allNodes().find(node => node.className === 'askgpt-chat-sources').textContent, '');

    assert.match(firstPageButtons[1].getAttribute('aria-label'), /Second exact passage$/);
    firstPageButtons[1].emit('click');
    await tick();
    assert.deepEqual(f.calls.at(-1), {action: 'jump', clientID: f.clientID, messageID: id, marker: 'p10.3'});
  } finally { f.dock.dispose(); }
});

test('markers stay out of generated code and unmatched sources are explicitly unplaced', async () => {
  const id = randomUUID(), sources = [source(1, 1, 'A code-only marker'), source(2, 1, 'A quoted source')];
  const markedText = '\x60code [[p1.1]]\x60 and **strong [[p2.1]] evidence**';
  const f = fixture({respond: () => reply('1:FIRST001', {messages: [{id, role: 'assistant', completed: true,
    text: '\x60code \x60 and **strong  evidence**', markedText, sources}]})});
  try {
    f.dock.show({page: 0});
    await tick();
    const body = f.transcript.allNodes().find(node => node.className === 'askgpt-chat-text');
    assert.equal(body.allNodes().find(node => node.tagName === 'code').textContent, 'code ');
    const emphasis = body.allNodes().find(node => node.tagName === 'strong');
    assert.match(emphasis.textContent, /strong PDF p\. 2 evidence/);
    assert.equal(body.allNodes().filter(node => node.tagName === 'button').length, 1);
    const footer = f.transcript.allNodes().find(node => node.className === 'askgpt-chat-sources');
    assert.match(footer.textContent, /Sources without an inline location.*PDF p\. 1/);
    assert.doesNotMatch(footer.textContent, /PDF p\. 2/);
  } finally { f.dock.dispose(); }
});

test('saved assistant text renders emphasis, preserves scientific literals, and stays inert', async () => {
  const answer = [
    '## 组装结论',
    '**折叠组装**有局限，结果仅*提示*趋势。',
    '- __结果__：k*x*y；HLA-A*02:01；\x60a ** b\x60；$*x*$；\\* P < 0.05。',
    '**<img src=x onerror=fail()>**',
    '\x60\x60\x60r',
    '**保持原样**',
    '\x60\x60\x60'
  ].join('\n');
  const state = reply('1:FIRST001', {messages: [
    {id: randomUUID(), role: 'user', text: '**请按原字提问**', completed: true},
    {id: randomUUID(), role: 'assistant', text: answer, completed: true}
  ]});
  const f = fixture({respond: () => state});
  try {
    f.dock.show({page: 0});
    await tick();
    const bodies = f.transcript.allNodes().filter(node => node.className === 'askgpt-chat-text');
    const [question, rendered] = bodies;
    const nodes = rendered.allNodes();
    assert.equal(question.textContent, '**请按原字提问**');
    assert.deepEqual(nodes.filter(node => node.tagName === 'strong').map(node => node.textContent),
      ['组装结论', '折叠组装', '结果', '<img src=x onerror=fail()>']);
    assert.deepEqual(nodes.filter(node => node.tagName === 'em').map(node => node.textContent), ['提示']);
    assert.deepEqual(nodes.filter(node => node.tagName === 'code').map(node => node.textContent), ['a ** b', '**保持原样**']);
    assert.match(rendered.textContent, /k\*x\*y；HLA-A\*02:01；a \*\* b；\$\*x\*\$；\* P < 0\.05。/);
    assert.match(rendered.textContent, /组装结论\n折叠组装有局限，结果仅提示趋势。\n• 结果/);
    assert.equal(nodes.some(node => node.tagName === 'img'), false);
  } finally { f.dock.dispose(); }
});

test('streaming emphasis renders when complete and unfinished syntax does not flash', async () => {
  const id = randomUUID();
  let text = '已经核实。 **折叠组装', isSending = true;
  const f = fixture({respond: () => reply('1:FIRST001', {
    isSending, messages: [{id, role: 'assistant', text, completed: !isSending}]
  })});
  async function firePoll() {
    const [id, poll] = f.timers.entries().next().value;
    f.timers.delete(id);
    poll();
    await tick();
  }
  try {
    f.dock.show({page: 0});
    await tick();
    const body = f.transcript.allNodes().find(node => node.className === 'askgpt-chat-text');
    assert.equal(body.textContent, '已经核实。 折叠组装');
    text += '**';
    await firePoll();
    assert.equal(body.textContent, '已经核实。 折叠组装');
    assert.equal(f.transcript.allNodes().find(node => node.tagName === 'strong').textContent, '折叠组装');
    text += '。代码末尾的 *';
    await firePoll();
    isSending = false;
    await firePoll();
    assert.match(body.textContent, /代码末尾的 \*$/);
  } finally { f.dock.dispose(); }
});

test('completed CJK prose repairs orphan stars and renders multiline emphasis', async () => {
  const text = [
    '目前只有这种结果。 ** 而且无法断言。 ***',
    '',
    '**第一行原话',
    '第二行原话**依然保留。',
    '',
    '原始科学符号：浓度**2，k ** 3，HLA-A*02:01；\x60**代码**\x60；$a ** b$；\\***显式星号。',
    '',
    'This is a plain sentence **'
  ].join('\n');
  const f = fixture({respond: () => reply('1:FIRST001', {
    messages: [{id: randomUUID(), role: 'assistant', text, completed: true}]
  })});
  try {
    f.dock.show({page: 0});
    await tick();
    const body = f.transcript.allNodes().find(node => node.className === 'askgpt-chat-text');
    assert.match(body.textContent, /^目前只有这种结果。 而且无法断言。\n\n/);
    assert.equal(body.allNodes().find(node => node.tagName === 'strong').textContent, '第一行原话\n第二行原话');
    assert.match(body.textContent, /浓度\*\*2，k \*\* 3，HLA-A\*02:01；\*\*代码\*\*；\$a \*\* b\$；\*\*\*显式星号。/);
    assert.match(body.textContent, /This is a plain sentence$/);
  } finally { f.dock.dispose(); }
});

test('new questions follow the current physical viewport after the attached selection is consumed', async () => {
  const f = fixture();
  try {
    f.dock.show({page: 0, selection: {pageIndex: 0, text: 'Attached selection'}});
    await tick();
    f.submit('First question');
    await tick();
    assert.equal(f.reads.length, 1, 'the first send reuses the extracted snapshot');
    assert.equal(f.calls.at(-1).context.selection, 'Attached selection');
    f.setPage(7);
    f.submit('Second question');
    await tick();
    assert.equal(f.calls.at(-1).context.currentPage, 8);
    assert.equal(f.calls.at(-1).context.selection, '');
  } finally { f.dock.dispose(); }
});

test('old helper and restarted bridge recover in place without clearing or resending a draft', async () => {
  const transportCalls = [];
  let available = false, loseSession = false, probes = 0;
  const request = PaperChat.createTransport({
    Zotero: {HTTP: {async request(method, url, options) {
      const value = JSON.parse(options.body);
      transportCalls.push({method, url, options, value});
      if (!available) return json({}, 404);
      if (loseSession && value.action !== 'open') return json({error:{code:'paper_chat_unavailable'}}, 503);
      if (value.action === 'open') loseSession = false;
      return json(reply('1:FIRST001'));
    }}},
    readConnection: async () => ({token: 'synthetic-pairing'}),
    ensureReady: async () => { probes++; }
  });
  const f = fixture({request});
  try {
    f.dock.show({page: 5});
    f.input.value = 'Keep this draft';
    await tick();
    assert.match(f.dock.panel.textContent, /Update Ask for GPT/);
    available = true;
    f.button('Reconnect').emit('click');
    await tick();
    assert.equal(f.input.value, 'Keep this draft');
    loseSession = true;
    f.submit('Retain after restart');
    await tick();
    f.button('Reconnect').emit('click');
    await tick();
    assert.equal(f.input.value, 'Retain after restart');
    assert.deepEqual(transportCalls.map(call => call.value.action), ['open', 'open', 'send', 'open']);
    assert.equal(probes, 3);
    for (const {method, url, options} of transportCalls) {
      assert.equal(method, 'POST');
      assert.equal(url, 'http://127.0.0.1:43792/v1/inline/paper-chat');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-pairing');
      assert.equal(options.headers.Origin, undefined);
      assert.equal(options.followRedirects, false);
      assert.equal(options.logBodyLength, 0);
    }
  } finally { f.dock.dispose(); }
});

test('native update indicator only appears for an available version and sends one update action', async () => {
  const available = reply('1:FIRST001', {updateVersion: '1.2.0'});
  const f = fixture({respond: message => ({...available, updating: message.action === 'update'})});
  try {
    assert.equal(f.button('Update Ask for GPT').hidden, true);
    f.dock.show({page: 0});
    await tick();
    const arrow = f.button('Update Ask for GPT to 1.2.0');
    assert.equal(arrow.hidden, false);
    arrow.emit('click');
    await tick();
    assert.deepEqual(f.calls.at(-1), {action: 'update', clientID: f.clientID});
    assert.equal(f.button('Preparing Ask for GPT 1.2.0').disabled, true);
  } finally { f.dock.dispose(); }
});

function layoutFixture(readLayout) {
  const win = new Window(), doc = win.document;
  Object.assign(win, {innerWidth: 1_000, innerHeight: 800});
  doc.defaultView = win;
  doc.querySelector = selector => selector === '.toolbar' ? {getBoundingClientRect: () => ({bottom: 48})} : null;
  const stored = [];
  const dock = PaperChat.mount({doc, clientID: randomUUID(), chinese: false,
    request: async () => reply('1:FIRST001'), extract: async () => ({attachmentID: '1:FIRST001'}),
    readInputs: () => ({page: 0}), isCurrent: () => true, setTimer: setTimeout, clearTimer: clearTimeout,
    loadLayout: () => readLayout, saveLayout: value => stored.push(JSON.parse(value))});
  dock.show();
  const {panel} = dock;
  const find = css => doc.body.allNodes().find(node => node.className === css);
  const header = find('askgpt-chat-header'), handle = find('askgpt-chat-move');
  const resize = find('askgpt-chat-resize');
  const metric = key => parseFloat(panel.style.getPropertyValue('--askgpt-chat-' + key));
  const sendPointer = (type, id, x, y) => doc.emit(type, {pointerId: id, clientX: x, clientY: y});
  const start = (target, id, x, y, source = target) => target.emit('pointerdown',
    {pointerId: id, currentTarget: target, target: source, button: 0, clientX: x, clientY: y});
  const stretch = (width, height) => { Object.assign(win, {innerWidth: width, innerHeight: height}); win.emit('resize'); };
  return {doc, win, panel, dock, header, handle, resize, stored, metric, sendPointer, start, stretch};
}

test('the chat can be moved and reopened in place after minimizing without a launcher', async () => {
  const f = layoutFixture();
  try {
    const startTop = f.metric('top');
    assert.equal(f.metric('left'), 12);
    const actualButton = f.panel.allNodes().find(node => node.getAttribute('aria-label') === 'Minimize paper chat');
    actualButton.closest = () => actualButton;
    f.start(f.header, 1, 120, 500, actualButton);
    f.sendPointer('pointermove', 1, 800, 700);
    assert.equal(f.metric('left'), 12);
    assert.equal(f.stored.length, 0);

    let captured;
    f.header.setPointerCapture = id => { captured = id; };
    f.header.hasPointerCapture = id => captured === id;
    f.header.releasePointerCapture = () => { captured = null; };
    f.start(f.header, 2, 120, 500);
    f.sendPointer('pointermove', 2, 122, 501);
    f.sendPointer('pointermove', 3, 640, 300);
    assert.equal(f.metric('left'), 12, 'ignores click-sized travel and other pointers');
    f.sendPointer('pointermove', 2, 320, 450);
    assert.equal(f.metric('left'), 212, 'drag preserves original pointer offset');
    assert.equal(f.metric('top'), startTop - 50);
    assert.equal(f.stored.length, 0, 'preferences are written once per completed gesture');
    f.sendPointer('pointerup', 2, 320, 450);
    assert.equal(captured, null);
    assert.equal(f.stored.length, 1);
    assert.deepEqual(Object.keys(f.stored[0]), ['x', 'y', 'width', 'height']);

    actualButton.emit('click');
    assert.equal(f.dock.opened, false);
    assert.deepEqual(f.doc.body.children, [f.panel], 'minimizing leaves no separate reader button');
    f.dock.show();
    assert.equal(f.metric('left'), 212);
    assert.equal(f.metric('top'), startTop - 50);
    assert.equal(f.stored.length, 1);
  } finally { f.dock.dispose(); }
  assert.equal(f.win.listenerCount(), 0);
  assert.equal(f.doc.listenerCount(), 0);
});

test('resizing from the interior corner keeps the lower edge and restores chosen size after viewport changes', async () => {
  const f = layoutFixture();
  try {
    const startHeight = f.metric('height');
    assert.equal(f.panel.getAttribute('data-resize-x'), 'right');
    assert.equal(f.panel.getAttribute('data-resize-y'), 'top');
    f.start(f.resize, 1, 400, 400);
    f.sendPointer('pointermove', 1, 530, 300);
    f.sendPointer('pointerup', 1, 530, 300);
    assert.equal(f.metric('width'), 530);
    assert.equal(f.metric('height'), startHeight + 100);
    assert.equal(f.metric('top') + f.metric('height'), 788);
    const preference = f.stored.at(-1);
    assert.equal(preference.width, 530);
    f.dock.setActive(false);
    f.stretch(310, 260);
    f.dock.setActive(true);
    assert.ok(f.metric('left') + f.metric('width') <= 310);
    assert.ok(f.metric('top') + f.metric('height') <= 260);
    assert.equal(f.stored.length, 1, 'viewport changes do not overwrite the preferred dimensions');
    f.stretch(1000, 800);
    assert.equal(f.metric('width'), preference.width);
    assert.equal(f.metric('height'), preference.height);
    const reopened = layoutFixture(JSON.stringify(preference));
    try {
      assert.equal(reopened.metric('width'), preference.width);
      assert.equal(reopened.metric('height'), preference.height);
    } finally { reopened.dock.dispose(); }
  } finally { f.dock.dispose(); }
});

test('focusable handles support keyboard movement and resizing after an invalid saved layout', async () => {
  const f = layoutFixture('{"x":1,"y":1,"width":"untrusted","height":400}');
  try {
    assert.equal(f.metric('width'), 400);
    assert.equal(f.metric('left'), 12);
    const event = f.handle.emit('keydown', {key: 'ArrowRight', currentTarget: f.handle});
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.metric('left'), 28);
    f.resize.emit('keydown', {key: 'ArrowRight', currentTarget: f.resize});
    assert.equal(f.metric('width'), 416);
    assert.match(f.panel.textContent, /Paper chat resized/);
  } finally { f.dock.dispose(); }
});

test('edge grips resize one axis and fit follows the reader before restoring the custom size', () => {
  const f = layoutFixture();
  const control = label => f.panel.allNodes().find(node => node.getAttribute('aria-label') === label);
  try {
    const initialHeight = f.metric('height');
    f.start(control('Resize chat width'), 1, 410, 400);
    f.sendPointer('pointermove', 1, 470, 465);
    f.sendPointer('pointerup', 1, 470, 465);
    assert.equal(f.metric('width'), 460);
    assert.equal(f.metric('height'), initialHeight);
    f.start(control('Resize chat height'), 2, 200, 400);
    f.sendPointer('pointermove', 2, 245, 350);
    f.sendPointer('pointerup', 2, 245, 350);
    assert.equal(f.metric('width'), 460);
    assert.equal(f.metric('height'), initialHeight + 50);
    control('Fit reading area').emit('click');
    assert.deepEqual(['left', 'top', 'width', 'height'].map(f.metric), [12, 48, 976, 740]);
    f.stretch(800, 600);
    assert.deepEqual(['width', 'height'].map(f.metric), [776, 540]);
    control('Restore window size').emit('click');
    assert.deepEqual(['width', 'height'].map(f.metric), [460, initialHeight + 50]);
    assert.equal(f.stored.length, 2);
  } finally { f.dock.dispose(); }
});

test('conversation find is local, navigates matching messages, and keeps the draft across window controls', async () => {
  const state = reply('1:FIRST001', {messages: [
    {id: randomUUID(), role: 'user', text: 'Find the ＳＶ result', completed: true},
    {id: randomUUID(), role: 'assistant', text: 'A different answer', completed: true},
    {id: randomUUID(), role: 'assistant', text: '**SV** evidence', completed: true}
  ]});
  const f = fixture({respond: () => state});
  try {
    f.dock.show();
    await tick();
    f.input.value = 'Keep this draft';
    const {panel} = f.dock;
    const windowControls = panel.allNodes().find(node => node.className === 'askgpt-chat-traffic');
    assert.deepEqual(windowControls.children.map(control => control.getAttribute('aria-label')),
      ['Close paper chat', 'Minimize paper chat', 'Fit reading area']);
    const findBar = panel.allNodes().find(node => node.getAttribute('role') === 'search');
    const search = findBar.children[0], count = findBar.children[1];
    const selected = () => f.transcript.children.find(row => row.getAttribute('data-search-current'));
    assert.equal(findBar.hidden, true);
    const shortcut = panel.emit('keydown', {key: 'f', metaKey: true});
    assert.equal(shortcut.defaultPrevented, true);
    search.value = 'sv';
    search.emit('input');
    assert.equal(count.textContent, '1 / 2');
    assert.equal(selected(), f.transcript.children[0]);
    assert.equal(search.emit('keydown', {key: 'Enter', isComposing: true}).defaultPrevented, undefined);
    assert.equal(selected(), f.transcript.children[0]);
    f.button('Next match').emit('click');
    assert.equal(count.textContent, '2 / 2');
    assert.equal(selected(), f.transcript.children[2]);
    search.emit('keydown', {key: 'Enter', shiftKey: true});
    assert.equal(selected(), f.transcript.children[0]);
    search.value = 'not present';
    search.emit('input');
    assert.equal(count.textContent, 'No matches');
    assert.equal(f.button('Next match').disabled, true);
    assert.deepEqual(f.calls.map(item => item.action), ['open']);
    panel.emit('keydown', {key: 'Escape'});
    assert.equal(findBar.hidden, true);
    assert.equal(f.dock.opened, true);
    f.button('Minimize paper chat').emit('click');
    assert.equal(panel.getAttribute('data-minimized'), 'true');
    assert.equal(f.button('Fit reading area').disabled, true);
    assert.equal(panel.hidden, false);
    f.button('Restore paper chat').emit('click');
    assert.equal(f.dock.opened, true);
    assert.equal(f.button('Fit reading area').disabled, false);
    f.button('Close paper chat').emit('click');
    assert.equal(panel.hidden, true);
    f.dock.show();
    assert.equal(f.dock.opened, true);
    assert.equal(f.input.value, 'Keep this draft');
    assert.equal(f.transcript.children.length, 3);
  } finally { f.dock.dispose(); }
});
