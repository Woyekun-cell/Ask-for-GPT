'use strict';
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const test = require('node:test');
const {Document, Window} = require('./fake-dom.cjs');
const PaperChat = require('../content/paper-chat-panel.js');
const Commands = require('../content/paper-commands.js');
const {parse} = require('../content/paper-command-parser.js');

const SOURCE = 'The samples were collected independently.';
const SECOND = 'The assay was repeated twice.';
const ANSWER = 'The paper describes how the samples were collected.';
const ATTACHMENT_ID = '1:ATTACH01';
const citation = (page, quote) => ({page, marker: 'p' + page + '.1', quote});
const chatMessage = (role, text, completed = true) => ({id: randomUUID(), role, text, completed});
const turn = () => new Promise(setImmediate);
function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {promise, release};
}

async function until(check, description) {
  const stop = performance.now() + 2500;
  while (performance.now() < stop) {
    const result = check();
    if (result) return result;
    await turn();
  }
  assert.fail(description);
}

function fixture({sources = [citation(1, SOURCE)], evidencePoints, extraction, noteSave,
  texts = [SOURCE, SECOND], translateTopic, noAnswer = false, answer = ANSWER, selection,
  earlierMessages = [], paperTitle = 'Fixture paper', abstract = '', bridge, localActions} = {}) {
  const doc = new Document(), pdfWindow = new Window();
  const events = [], requests = [], reads = [], rows = new Map(), painted = new Set();
  const navigated = [], openedNotes = [];
  const statePolls = new Set();
  let nextID = 20;
  const attachment = {
    id: 12, key: 'ATTACH01', libraryID: 1, parentID: 10, attachmentContentType: 'application/pdf',
    isAttachment: () => true, isPDFAttachment: () => true, isEditable: () => true,
    getAnnotations: () => [...rows.values()].filter(item => item.isAnnotation?.() && item.parentID === 12 && !item.deleted),
  };
  const parent = {
    id: 10, key: 'PARENT01', libraryID: 1, isRegularItem: () => true, isEditable: () => true,
    getField: name => name === 'title' ? paperTitle : name === 'abstractNote' ? abstract : '',
    getNotes: () => [...rows.values()].filter(item => item.isNote?.() && item.parentID === 10 && !item.deleted).map(item => item.id),
  };
  rows.set(attachment.id, attachment);
  rows.set(parent.id, parent);
  class Item {
    constructor(type) { this.itemType = type; this._tags = []; this.deleted = false; }
    setNote(html) { this._note = html; }
    getNote() { return this._note; }
    setTags(tags) { this._tags = tags; }
    getTags() { return this._tags; }
    isAnnotation() { return this.itemType === 'annotation'; }
    isNote() { return this.itemType === 'note'; }
    isEditable() { return true; }
    async save() {
      if (this.isNote() && noteSave) await noteSave.promise;
      if (!this.id) this.id = ++nextID;
      this.key ||= 'ITEM' + String(this.id).padStart(4, '0');
      rows.set(this.id, this);
      events.push(['write', this.itemType]);
      return this.id;
    }
    saveTx(options) { return this.save(options); }
    async erase() { rows.delete(this.id); }
    eraseTx(options) { return this.erase(options); }
  }
  const byKey = (library, key) => [...rows.values()].find(item => item.libraryID === library && item.key === key);
  const Zotero = {
    Items: {get: id => rows.get(id), getByLibraryAndKey: byKey}, Item,
    Libraries: {get: () => ({editable: true})},
    DB: {executeTransaction: async fn => fn()},
    getActiveZoteroPane: () => ({openNote: (id, options) => openedNotes.push({id, options})}),
    Notifier: {Queue: class {}, async commit() {
      events.push(['notify']);
      for (const item of attachment.getAnnotations()) painted.add(item.key);
    }},
  };
  const chars = text => [...text].map((c, index) => ({c, rect: [30 + 5 * index, 740, 35 + 5 * index, 750]}));
  pdfWindow.PDFViewerApplication = {pdfDocument: {numPages: texts.length},
    pdfViewer: {pagesCount: texts.length, currentPageNumber: 1}};
  const view = {
    _iframeWindow: pdfWindow, _pdfPages: texts.map(text => ({chars: chars(text)})),
    _getPageLabel: index => String(index + 1),
    navigateToPosition: position => navigated.push(position),
  };
  const reader = {itemID: 12, type: 'pdf', _internalReader: {_primaryView: view},
    unsetAnnotations: keys => keys.forEach(key => painted.delete(key))};
  Zotero.Reader = {_readers: [reader]};
  const commands = Commands.create({Zotero, Components: {utils: {cloneInto: structuredClone}},
    reader, isCurrent: () => true, setTimer: setTimeout, clearTimer: clearTimeout, translateTopic});
  const reply = {
    attachmentID: ATTACHMENT_ID, title: 'Fixture paper', model: 'Never called',
    scope: 'nearby', isSending: false, localActions,
    messages: noAnswer ? [] : [...earlierMessages.map(([role, text]) => ({id: randomUUID(), role, text, completed: true})),
      {id: randomUUID(), role: 'assistant', text: answer, sources, evidencePoints, completed: true}],
  };
  const dock = PaperChat.mount({
    doc, clientID: randomUUID(), chinese: true, commands, parseCommand: parse,
    request: async message => {
      requests.push(message.action);
      return bridge ? bridge(message, reply) : reply;
    },
    extract: async inputs => {
      reads.push(inputs);
      if (extraction) await extraction.promise;
      return {attachmentID: ATTACHMENT_ID};
    },
    readInputs: () => ({page: 0, selection}),
    isCurrent: () => true,
    setTimer: bridge ? callback => { statePolls.add(callback); return callback; } : setTimeout,
    clearTimer: bridge ? callback => statePolls.delete(callback) : clearTimeout,
  });
  const nodes = () => doc.body.allNodes();
  const form = nodes().find(node => node.tagName === 'form');
  const input = nodes().find(node => node.tagName === 'textarea');
  const stop = nodes().find(node => node.getAttribute('aria-label') === '停止');
  const receipts = () => nodes().filter(node => node.getAttribute('aria-label') === 'Zotero 操作');
  function submit(text) {
    input.value = text;
    input.emit('input');
    const started = performance.now();
    form.emit('submit');
    return started;
  }
  const notes = () => [...rows.values()].filter(item => item.isNote?.());
  doc.onText = (_, value) => {
    if (/^已(?:保存|撤销|更新)/.test(value)) events.push(['receipt']);
  };
  dock.show({page: 0});
  return {dock, events, requests, reads, receipts, attachment, notes, submit, input, painted, navigated, openedNotes,
    stop, shows: text => nodes().some(node => node.textContent === text),
    poll: async () => {
      const tick = await until(() => statePolls.values().next().value, 'chat did not schedule a state poll');
      statePolls.delete(tick);
      tick();
      await turn();
    },
    ready: () => until(() => nodes().some(node => node.textContent === (noAnswer ? reply.title : answer) ||
      (answer !== ANSWER && node.getAttribute('aria-label') === '助手')),
      'open response did not render')};
}

test('the reported title command marks the original paper title independently of the latest answer', async () => {
  const title = 'Fixture paper about paired samples';
  const f = fixture({texts: [title, SECOND], paperTitle: title, sources: [], answer: '第一节：方法创新'});
  try {
    await f.ready();
    f.submit('高亮大标题');
    const reply = await until(() => f.receipts()[0], 'title command fell through to Q&A');
    assert.match(reply.textContent, /已保存 1 条标注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationText, title);
    assert.equal(mark.annotationColor, '#ffd400');
    assert.equal(JSON.parse(mark.annotationPosition).pageIndex, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('a title that cannot be matched to the PDF yields local feedback without writing', async () => {
  const f = fixture({paperTitle: 'A title not present in the PDF'});
  try {
    await f.ready();
    f.submit('高亮一下标题');
    const reply = await until(() => f.receipts()[0], 'missing title did not get a local response');
    assert.match(reply.textContent, /未能在原文中唯一定位论文标题/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported abstract command highlights the actual abstract rather than its label', async () => {
  const abstract = SOURCE + ' ' + SECOND;
  const f = fixture({texts: ['Abstract. ' + abstract + ' Introduction.', 'Other text.'],
    abstract, sources: [], answer: '🟨 **摘要**'});
  try {
    await f.ready();
    f.submit('高亮摘要');
    const reply = await until(() => f.receipts()[0], 'abstract command fell through to Q&A');
    assert.match(reply.textContent, /已保存 1 条标注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationText, abstract);
    assert.equal(JSON.parse(mark.annotationPosition).pageIndex, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported undo phrase revokes the latest highlight while keeping a later note', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.submit('把引用1标黄');
    await until(() => f.receipts()[0], 'initial highlight did not save');
    f.submit('写笔记「保留这条笔记」');
    await until(() => f.receipts()[1], 'later note did not save');
    f.submit('撤回这个高亮');
    const reply = await until(() => f.receipts()[2], 'highlight undo did not get feedback');
    assert.match(reply.textContent, /已撤销 1 项操作/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.equal(f.notes().filter(note => !note.deleted).length, 1);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported undo phrase leaves a multi-highlight batch intact', async () => {
  const f = fixture({sources: [], answer: '> ' + SOURCE + '\n\n> ' + SECOND});
  try {
    await f.ready();
    f.submit('高亮一下刚刚的');
    await until(() => f.receipts()[0], 'two highlights did not save');
    f.submit('撤回这个高亮');
    const reply = await until(() => f.receipts()[1], 'ambiguous undo did not get feedback');
    assert.match(reply.textContent, /上次保存了多条高亮/);
    assert.equal(f.attachment.getAnnotations().length, 2);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('asking if Zotero can be edited gets local capability help without a write', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.submit('没办法编辑zotero么');
    const reply = await until(() => f.receipts()[0], 'Zotero capability question went to the model');
    assert.match(reply.textContent, /保存高亮、下划线、PDF 批注和论文笔记/);
    assert.match(reply.textContent, /把这条回答存成笔记/);
    assert.equal(f.input.value, '');
    assert.deepEqual(f.requests, ['open']);
    assert.deepEqual(f.events, []);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.equal(f.notes().length, 0);
  } finally { f.dock.dispose(); }
});

test('a retry uses recommended original sentences across intervening capability replies', async () => {
  const f = fixture({sources: [], answer: '当前连接不能编辑 Zotero。', earlierMessages: [
    ['assistant', '> The samples were **collected independently**.\n\n> ' + SECOND],
    ['user', '这是纯文本么'],
    ['assistant', '这里显示的是文本。'],
    ['user', '没办法编辑zotero么'],
  ]});
  try {
    await f.ready();
    f.submit('再试试高亮一下');
    const reply = await until(() => f.receipts()[0], 'retry reached the model');
    assert.match(reply.textContent, /已保存 2 条标注/);
    assert.deepEqual(f.requests, ['open']);
    assert.deepEqual(f.attachment.getAnnotations().map(item => item.annotationText), [SOURCE, SECOND]);
  } finally { f.dock.dispose(); }
});

test('an unrelated question keeps a bare highlight request from using an older answer', async () => {
  const f = fixture({sources: [], answer: '这个问题需要补充实验才能回答。', earlierMessages: [
    ['assistant', '> ' + SOURCE],
    ['user', '这个结论能推广到其他样本吗？'],
  ]});
  try {
    await f.ready();
    f.submit('能高亮一下吗');
    const reply = await until(() => f.receipts()[0], 'retry produced no local feedback');
    assert.match(reply.textContent, /当前回答没有可标注的原文引用/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported polite request marks original quotes even outside the current question context', async () => {
  const unreproduced = 'The samples were collected at an entirely different time.';
  const f = fixture({sources: [citation(1, SOURCE)], answer: [
    '建议标以下原句。', '', '   > ' + SOURCE, '', '🟨 **' + SECOND + '**', '', '> ' + unreproduced,
  ].join('\n')});
  try {
    await f.ready();
    f.submit('能高亮一下吗');
    const saved = await until(() => f.receipts()[0], 'polite highlight request fell through to Q&A');
    assert.match(saved.textContent, /已保存 2 条标注/);
    assert.match(saved.textContent, /1 条建议原句未能唯一定位/);
    assert.deepEqual(f.attachment.getAnnotations().map(item => item.annotationText), [SOURCE, SECOND]);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the exact follow-up writes the two original sentences beneath the yellow suggestion labels', async () => {
  const f = fixture({sources: [], answer: [
    '下面把刚才选的两句标出来。', '',
    '🟨 **方法创新**：「摘要」  ', 'The samples were **collected independently**.', '',
    '🟨 **核心结论（只划一句就划这句）**：「摘要」  ', SECOND, '',
    'The unrelated explanation contains enough words to be a full sentence.',
  ].join('\n')});
  try {
    await f.ready();
    f.submit('高亮一下刚刚的');
    const reply = await until(() => f.receipts()[0], 'contextual highlight did not get a local response');
    assert.match(reply.textContent, /已保存 2 条标注/);
    assert.deepEqual(f.attachment.getAnnotations().map(item => item.annotationText), [SOURCE, SECOND]);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('a request for two recent sentences does not mark a larger or smaller set', async () => {
  const f = fixture({sources: [], answer: '> ' + SOURCE});
  try {
    await f.ready();
    f.submit('把刚才那两句标黄');
    const reply = await until(() => f.receipts()[0], 'specific count did not get a local response');
    assert.match(reply.textContent, /无法确定你指的是哪 2 句/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported polite request prefers an explicit original PDF selection', async () => {
  const selection = {text: 'independently', pageIndex: 0, position: {pageIndex: 0, rects: [[30, 740, 55, 750]]}};
  const f = fixture({selection});
  try {
    await f.ready();
    f.submit('能高亮一下吗');
    const saved = await until(() => f.receipts()[0], 'polite highlight request did not mark the native selection');
    assert.match(saved.textContent, /已保存 1 条标注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationText, selection.text);
    assert.deepEqual(JSON.parse(mark.annotationPosition), selection.position);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('the reported polite request asks for a target when no selection or answer exists', async () => {
  const f = fixture({noAnswer: true});
  try {
    await f.ready();
    f.submit('能高亮一下吗');
    const clarification = await until(() => f.receipts()[0], 'missing target did not get local feedback');
    assert.match(clarification.textContent, /请先在 PDF 划选原文，或指定要标哪一句/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('a topic instruction scans every page and saves exact original sentences before any answer', async () => {
  const first = 'The verification stage used thirty trials.';
  const second = 'The verification stage was repeated independently.';
  const translated = [];
  const f = fixture({noAnswer: true, texts: [SOURCE + ' ' + first, second + ' ' + SECOND],
    translateTopic: async topic => { translated.push(topic); return 'Verification stage'; }});
  try {
    await f.ready();
    f.submit('高亮所有关于验证阶段的原句');
    const receipt = await until(() => f.receipts()[0], 'topic scan did not produce a receipt');
    assert.match(receipt.textContent, /已读取 2\/2 页，按主题词找到 2 条原文，已保存 2 条标注/);
    const marks = f.attachment.getAnnotations();
    assert.deepEqual(marks.map(mark => mark.annotationText), [first, second]);
    assert.deepEqual(marks.map(mark => JSON.parse(mark.annotationPosition).pageIndex), [0, 1]);
    assert.deepEqual(f.requests, ['open']);
    assert.equal(f.reads.length, 1);
    assert.deepEqual(translated, ['验证阶段']);
  } finally { f.dock.dispose(); }
});

test('the real chat form saves explicit notes while initial question extraction is still pending', async () => {
  const extraction = deferred(), noteSave = deferred();
  const f = fixture({extraction, noteSave});
  try {
    f.submit('写笔记「先记下来」');
    await turn();
    assert.deepEqual(f.requests, []);
    assert.equal(f.reads.length, 1, 'only the initial chat open starts extraction');
    assert.equal(f.notes().length, 0);
    assert.equal(f.receipts().length, 0, 'a receipt cannot precede the native write');
    noteSave.release();
    const receipt = await until(() => f.receipts()[0], 'local note could not complete while chat was opening');
    assert.match(receipt.textContent, /已保存 1 条笔记/);
    assert.equal(f.notes()[0].parentID, 10);
    assert.match(f.notes()[0].getNote(), /先记下来/);
    assert.deepEqual(f.events.map(event => event[0]), ['write', 'notify', 'receipt']);
    assert.deepEqual(f.requests, []);
  } finally {
    f.dock.dispose();
    extraction.release();
    noteSave.release();
  }
});

test('one chat instruction highlights the cited sentence, saves the comment and makes a child note', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.submit('把你刚才引用的那句标黄，批注写「这里需要核对样本量」，再把这轮总结存到这篇论文下面');
    const receipt = await until(() => f.receipts()[0], 'combined command did not produce a receipt');
    assert.match(receipt.textContent, /已保存 1 条标注，已保存 1 条笔记/);
    assert.deepEqual(f.requests, ['open']);
    assert.equal(f.reads.length, 1);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(f.painted.has(mark.key), true);
    assert.equal(mark.parentID, 12);
    assert.equal(mark.annotationText, SOURCE);
    assert.equal(mark.annotationComment, '这里需要核对样本量');
    assert.equal(mark.annotationColor, '#ffd400');
    assert.deepEqual(JSON.parse(mark.annotationPosition),
      {pageIndex: 0, rects: [[30, 740, 30 + 5 * SOURCE.length, 750]]});
    const [note] = f.notes();
    assert.equal(note.parentID, 10);
    assert.match(note.getNote(), /The paper describes how the samples were collected\./);
    assert.match(note.getNote(), /The samples were collected independently\./);
    assert.deepEqual(f.events.map(event => event[0]), ['write', 'write', 'notify', 'receipt']);
    receipt.allNodes().find(node => node.getAttribute('aria-label') === '查看标注原文 ' + SOURCE).emit('click');
    receipt.allNodes().find(node => node.getAttribute('aria-label') === '打开笔记').emit('click');
    await until(() => f.navigated.length === 1, 'saved passage link did not navigate');
    assert.deepEqual(f.navigated, [JSON.parse(mark.annotationPosition)]);
    assert.deepEqual(f.openedNotes, [{id: note.id, options: {openInWindow: true}}]);
  } finally { f.dock.dispose(); }
});

test('ambiguity returns citation choices with no partial write or model request', async () => {
  const f = fixture({sources: [citation(1, SOURCE), citation(2, SECOND)]});
  try {
    await f.ready();
    f.submit('把你刚才引用的那句标黄，再把这轮总结存到这篇论文下面');
    const receipt = await until(() => f.receipts()[0], 'ambiguity did not produce a clarification');
    assert.match(receipt.textContent, /引用 1、引用 2/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    assert.equal(f.notes().length, 0);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('a follow-up color change targets the highlight made in this chat', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.submit('把引用1标黄');
    await until(() => f.receipts().length === 1, 'initial highlight did not complete');
    assert.equal(f.attachment.getAnnotations()[0].annotationColor, '#ffd400');
    f.submit('把刚才的高亮改蓝');
    await until(() => f.receipts().length === 2, 'follow-up recolor did not complete');
    assert.match(f.receipts()[1].textContent, /已更新 1 条标注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationColor, '#2ea8e5');
    assert.equal(mark.annotationText, SOURCE);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});

test('mixed evidence never targets any restored assistant message', async t => {
  for (const oldPosition of [0, 1]) await t.test(oldPosition === 0 ? 'older assistant' : 'last assistant', async () => {
    let asked;
    const f = fixture({
      earlierMessages: [['assistant', '> ' + SOURCE]],
      sources: [citation(2, SECOND)], answer: '> ' + SECOND,
      bridge(message, reply) {
        if (message.action !== 'send') return reply;
        asked = message.question;
        const restored = reply.messages[oldPosition];
        return {...reply, messages: [
          ...reply.messages.filter(item => item !== restored),
          chatMessage('user', message.question), restored,
        ]};
      },
    });
    try {
      await f.ready();
      f.submit('解释这段，再把支撑结论的原句标黄');
      const receipt = await until(() => f.receipts()[0], 'restored answer did not settle the mixed action');
      assert.match(receipt.textContent, /已取消本轮的 Zotero 操作/);
      assert.match(asked, /^解释这段\s+请用引用块/);
      assert.doesNotMatch(asked, /标黄/);
      assert.equal(f.attachment.getAnnotations().length, 0);
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.requests, ['open', 'send']);
    } finally { f.dock.dispose(); }
  });
});

test('a mixed note waits for the new complete reply and preserves a new draft', async () => {
  const waitForSend = deferred();
  const draft = '下一条尚未发送的问题';
  const newAnswer = '第二套实验重复了两次。这是新回答。';
  let completed;
  const f = fixture({
    bridge: async (message, reply) => {
      if (message.action === 'state') return completed;
      if (message.action !== 'send') return reply;
      assert.equal(message.question, '解释一下这段话');
      await waitForSend.promise;
      const user = chatMessage('user', message.question);
      const assistant = chatMessage('assistant', newAnswer);
      completed = {...reply, messages: [...reply.messages, user, assistant]};
      return {...completed, isSending: true, messages: [
        ...reply.messages, user, {...assistant, text: '部分回答', completed: false},
      ]};
    },
  });
  try {
    await f.ready();
    f.submit('解释一下这段话，然后把回答存成笔记');
    await until(() => f.requests.includes('send'), 'mixed request never asked the model');
    f.input.value = draft;
    f.input.emit('input');
    waitForSend.release();
    await until(() => !f.stop.hidden && !f.stop.disabled, 'initial streaming response did not render');
    assert.equal(f.notes().length, 0);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.input.value, draft);

    await f.poll();
    const receipt = await until(() => f.receipts()[0], 'completed mixed note produced no receipt');
    assert.match(receipt.textContent, /已保存 1 条笔记/);
    const [note] = f.notes();
    assert.equal(note.parentID, 10);
    assert.match(note.getNote(), new RegExp(newAnswer));
    assert.doesNotMatch(note.getNote(), /The paper describes how the samples were collected/);
    assert.deepEqual(f.events.map(event => event[0]), ['write', 'notify', 'receipt']);
    assert.deepEqual(f.requests, ['open', 'send', 'state']);
    assert.equal(f.input.value, draft);
  } finally { waitForSend.release(); f.dock.dispose(); }
});

test('the reported abstract request saves the new summary beside the exact PDF abstract', async () => {
  const summary = '1. **样本独立收集。**\n2. 检测重复两次。';
  const f = fixture({abstract: SOURCE, bridge(message, reply) {
    if (message.action !== 'send') return reply;
    assert.match(message.question, /根据这篇论文的摘要/);
    return {...reply, messages: [...reply.messages, chatMessage('user', message.question), chatMessage('assistant', summary)]};
  }});
  try {
    await f.ready();
    f.submit('把摘要写了什么总结成笔记写在摘要的旁边分成几点');
    const receipt = await until(() => f.receipts()[0], 'summary was not attached to the abstract');
    assert.match(receipt.textContent, /已保存 1 条批注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationText, SOURCE);
    assert.match(mark.annotationComment, /样本独立收集。\n2\. 检测重复两次。/);
    assert.doesNotMatch(mark.annotationComment, /\*\*/);
    assert.equal(f.notes().length, 0);
    assert.deepEqual(f.requests, ['open', 'send']);
  } finally { f.dock.dispose(); }
});

test('new helper resolves varied user phrasing in one model turn and saves a local note', async () => {
  const original = '留个备忘，之后回头核对这两处。';
  let packet;
  const f = fixture({localActions: true, bridge(message, reply) {
    if (message.action === 'state') return packet;
    if (message.action !== 'send') return reply;
    assert.equal(message.resolveActions, true);
    assert.equal(message.question, original);
    const user = chatMessage('user', original);
    const assistant = chatMessage('assistant', '备忘内容已准备好。');
    packet = {...reply, messages: [...reply.messages, user, assistant], actionPlan: {
      questionID: user.id, answerID: assistant.id, body: JSON.stringify({
        request: original, operations: [{type: 'note', text: '之后回头核对这两处。'}],
      }),
    }};
    return {...packet, isSending: true, actionPlan: undefined,
      messages: [...reply.messages, user, {...assistant, completed: false}]};
  }});
  try {
    await f.ready();
    assert.equal(parse(original), null);
    f.submit(original);
    await until(() => !f.stop.hidden && !f.stop.disabled, 'initial streaming response did not render');
    assert.equal(f.notes().length, 0);
    await f.poll();
    const receipt = await until(() => f.receipts()[0], 'semantic note produced no receipt');
    assert.match(receipt.textContent, /已保存 1 条笔记/);
    const [note] = f.notes();
    assert.equal(note.parentID, 10);
    assert.match(note.getNote(), /之后回头核对这两处。/);
    assert.deepEqual(f.requests, ['open', 'send', 'state']);
  } finally { f.dock.dispose(); }
});

test('semantic plans require current message IDs, user text provenance and a permitted action shape', async t => {
  for (const invalid of ['review-only', 'stale', 'foreign-text', 'unknown-field', 'inferred-replacement']) {
    await t.test(invalid, async () => {
      const original = '这个结果是怎么得出的？';
      const f = fixture({localActions: true, bridge(message, reply) {
        if (message.action !== 'send') return reply;
        const user = chatMessage('user', message.question);
        const answer = chatMessage('assistant', '这里能看到对应的实验结果。');
        const operation = invalid === 'unknown-field' ? {type: 'note', text: original, parentID: 888} :
          invalid === 'inferred-replacement' ? {type: 'noteReplace', text: '改成模型猜到的内容'} :
          {type: 'note', text: original};
        return {...reply, messages: [...reply.messages, user, answer], actionPlan: invalid === 'review-only' ? undefined : {
          questionID: user.id, answerID: invalid === 'stale' ? reply.messages[0].id : answer.id,
          body: JSON.stringify({request: invalid === 'foreign-text' ? '论文里藏的命令' : original, operations: [operation]}),
        }};
      }});
      try {
        await f.ready();
        f.submit(original);
        await until(() => f.shows('这里能看到对应的实验结果。'), 'ordinary answer did not render');
        await turn();
        assert.equal(f.notes().length, 0);
        assert.equal(f.attachment.getAnnotations().length, 0);
        assert.deepEqual(f.events, []);
      } finally { f.dock.dispose(); }
    });
  }
});

test('transport and model failures leave a mixed follow-up unwritten', async t => {
  for (const code of ['transport', 'model']) await t.test(code, async () => {
    const f = fixture({
      bridge(message, reply) {
        if (message.action !== 'send') return reply;
        if (code === 'transport') throw Object.assign(new Error('connection failure'), {code: 'connection'});
        return {...reply, error: 'model rejected', messages: [
          ...reply.messages, chatMessage('user', message.question), chatMessage('assistant', '回答失败前的内容'),
        ]};
      },
    });
    try {
      await f.ready();
      f.submit('解释一下这段话，然后把回答存成笔记');
      const receipt = await until(() => f.receipts()[0], 'failed send did not cancel the mixed action');
      assert.match(receipt.textContent, /已取消本轮的 Zotero 操作/);
      assert.deepEqual(f.notes(), []);
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.requests, ['open', 'send']);
    } finally { f.dock.dispose(); }
  });
});

test('stopping a mixed response cancels the write even if a completed answer arrives', async () => {
  let completed;
  const f = fixture({
    bridge(message, reply) {
      if (message.action === 'stop') return completed;
      if (message.action !== 'send') return reply;
      const user = chatMessage('user', message.question);
      const assistant = chatMessage('assistant', '已停止前生成的回答');
      completed = {...reply, messages: [...reply.messages, user, assistant]};
      return {...completed, isSending: true, messages: [
        ...reply.messages, user, {...assistant, text: '部分回答', completed: false},
      ]};
    },
  });
  try {
    await f.ready();
    f.submit('解释一下这段话，然后把回答存成笔记');
    await until(() => !f.stop.hidden && !f.stop.disabled, 'mixed response was not stoppable');
    f.stop.emit('click');
    await until(() => f.shows('已停止前生成的回答'), 'stop response did not render');
    assert.match(f.receipts()[0].textContent, /已取消本轮的 Zotero 操作/);
    assert.deepEqual(f.notes(), []);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.requests, ['open', 'send', 'stop']);
  } finally { f.dock.dispose(); }
});

test('switching tabs cancels a mixed write while the answer is still in flight', async () => {
  const waitForSend = deferred();
  const newAnswer = '切换标签后完成的回答';
  let completed;
  const f = fixture({
    bridge: async (message, reply) => {
      if (message.action === 'state') return completed;
      if (message.action !== 'send') return reply;
      await waitForSend.promise;
      completed = {...reply, messages: [
        ...reply.messages, chatMessage('user', message.question), chatMessage('assistant', newAnswer),
      ]};
      return completed;
    },
  });
  try {
    await f.ready();
    f.submit('解释一下这段话，然后把回答存成笔记');
    await until(() => f.requests.includes('send'), 'mixed response never started');
    f.dock.setActive(false);
    waitForSend.release();
    await until(() => f.shows(newAnswer), 'late answer did not settle');
    f.dock.setActive(true);
    await until(() => f.requests.includes('state'), 'returning to the tab did not refresh the dialogue');
    await turn();
    assert.match(f.receipts()[0].textContent, /已取消本轮的 Zotero 操作/);
    assert.deepEqual(f.notes(), []);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.requests, ['open', 'send', 'state']);
  } finally { waitForSend.release(); f.dock.dispose(); }
});

test('warmed command timing counts submission through the Zotero mock write and chat receipt', async t => {
  const f = fixture();
  try {
    await f.ready();
    const samples = [];
    for (let index = 0; index <= 20; index++) {
      const before = f.receipts().at(-1), started = f.submit('把引用1标黄');
      const receipt = await until(() => {
        const next = f.receipts().at(-1);
        return next !== before ? next : null;
      }, 'timed highlight did not complete');
      assert.match(receipt.textContent, /已保存 1 条标注/);
      assert.equal(f.events.at(-1)[0], 'receipt');
      if (index) samples.push(performance.now() - started);
      f.submit('撤销刚才那一批');
      const undone = await until(() => {
        const next = f.receipts().at(-1);
        return next !== receipt ? next : null;
      }, 'test highlight was not undone');
      assert.match(undone.textContent, /已撤销 1 项操作/);
      assert.equal(f.attachment.getAnnotations().length, 0);
      assert.equal(f.painted.size, 0, 'reversible undo clears the PDF highlight already painted by the reader');
    }
    samples.sort((a, b) => a - b);
    assert.deepEqual(f.requests, ['open']);
    t.diagnostic('20 warmed highlights, mocked Zotero: median ' +
      ((samples[9] + samples[10]) / 2).toFixed(2) + ' ms, P95 ' + samples[18].toFixed(2) + ' ms');
  } finally { f.dock.dispose(); }
});


test('one cited point gets the saved source of that point without sending another model request', async () => {
  const sources = [citation(1, SOURCE), citation(2, SECOND)];
  const f = fixture({sources, evidencePoints: [{number: 1, markers: ['p1.1']}, {number: 2, markers: ['p2.1']}]});
  try {
    await f.ready();
    f.submit('把这个结论的证据标出来');
    const choices = await until(() => f.receipts()[0], 'ambiguous conclusion had no feedback');
    assert.match(choices.textContent, /第 1 点、第 2 点/);
    assert.equal(f.attachment.getAnnotations().length, 0);
    f.submit('把第2点的证据标黄');
    const saved = await until(() => f.receipts()[1], 'specific point did not save');
    assert.match(saved.textContent, /已保存 1 条标注/);
    const [mark] = f.attachment.getAnnotations();
    assert.equal(mark.annotationText, SECOND);
    assert.equal(JSON.parse(mark.annotationPosition).pageIndex, 1);
    assert.deepEqual(f.requests, ['open']);
    assert.equal(f.reads.length, 1);
  } finally { f.dock.dispose(); }
});

test('an unnumbered answer with one verified citation can highlight this conclusion locally', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.submit('把这个结论的证据标出来');
    const receipt = await until(() => f.receipts()[0], 'the one cited passage did not save');
    assert.match(receipt.textContent, /已保存 1 条标注/);
    assert.equal(f.attachment.getAnnotations()[0].annotationText, SOURCE);
    assert.deepEqual(f.requests, ['open']);
  } finally { f.dock.dispose(); }
});
