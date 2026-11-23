const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parse } = require('../content/paper-command-parser.js');

test('turns an imperative into one anchored annotation and one note in order', () => {
  const command = '把你刚才引用的那句标黄，批注写「这里需要核对样本量」，再把这轮总结存到这篇论文下面';
  assert.deepEqual(parse(command.replace('，批注', '并批注').replace('，再', '再')), parse(command));
  assert.deepEqual(parse(command), { operations: [
    { type: 'highlight', target: 'citation', color: '#ffd400', comment: '这里需要核对样本量' },
    { type: 'note' },
  ] });
});

test('uses exact quoted content without splitting punctuation inside the quote', () => {
  assert.deepEqual(parse("把『  Valid, paired samples.  』标蓝；批注写「核对 'n'，见结果。」"), { operations: [
    { type: 'highlight', quote: '  Valid, paired samples.  ', color: '#2ea8e5', comment: "核对 'n'，见结果。" },
  ] });
  assert.deepEqual(parse('写笔记「第一句。\n第二句。请高亮，看看结果。」'), {
    operations: [{ type: 'note', text: '第一句。\n第二句。请高亮，看看结果。' }]
  });
});

test('uses a 1-based citation index and distinguishes a text selection', () => {
  assert.deepEqual(parse('把引用2高亮'), { operations: [{ type: 'highlight', citation: 2 }] });
  assert.deepEqual(parse('把第十二条出处标紫'), {
    operations: [{ type: 'highlight', citation: 12, color: '#e56eee' }]
  });
  assert.deepEqual(parse('把我现在选中的这句话用绿色高亮'), {
    operations: [{ type: 'highlight', target: 'selection', color: '#5fb236' }]
  });
});

test('targets evidence for the current or a numbered conclusion', () => {
  assert.deepEqual(parse('把这个结论的证据标出来'), { operations: [{ type: 'evidence' }] });
  assert.deepEqual(parse('把第2点的证据标出来'), { operations: [{ type: 'evidence', point: 2 }] });
  assert.deepEqual(parse('把第二点的证据标黄'), {
    operations: [{ type: 'evidence', point: 2, color: '#ffd400' }]
  });
  assert.deepEqual(parse('请标出第 十二 个结论的证据'), {
    operations: [{ type: 'evidence', point: 12 }]
  });
  assert.deepEqual(parse('Highlight the evidence supporting point 2 in blue'), {
    operations: [{ type: 'evidence', point: 2, color: '#2ea8e5' }]
  });
  assert.deepEqual(parse('Mark the evidence for this conclusion'), { operations: [{ type: 'evidence' }] });
});

test('routes natural requests to highlight the current selection or answer evidence', () => {
  for (const request of ['能高亮一下吗', '可以帮我高亮一下吗？', '请高亮一下', '帮我高亮一下']) {
    assert.deepEqual(parse(request), { kind: 'contextHighlight' }, request);
  }
  assert.deepEqual(parse('帮我把刚才提到的原句高亮一下'), { kind: 'answerHighlight' });
  assert.deepEqual(parse('能把这些证据标黄吗'), { kind: 'answerHighlight', color: '#ffd400' });
  assert.deepEqual(parse('能把这些证据都标黄吗'), { kind: 'answerHighlight', color: '#ffd400' });
  assert.deepEqual(parse('把你刚才提到的那句话高亮一下'), { kind: 'answerHighlight' });
  assert.deepEqual(parse('把上面提到的那几句原文标蓝'), { kind: 'answerHighlight', color: '#2ea8e5' });
});

test('routes recent-answer shorthand with its explicit quantity', () => {
  for (const command of ['高亮一下刚刚的', '高亮刚刚的', '把刚刚的高亮一下', '能帮我高亮一下刚才的吗？']) {
    assert.deepEqual(parse(command), { kind: 'answerHighlight' }, command);
  }
  assert.deepEqual(parse('把刚才那两句标黄'), { kind: 'answerHighlight', color: '#ffd400', count: 2 });
  assert.deepEqual(parse('高亮一下上面提到的三条证据'), { kind: 'answerHighlight', count: 3 });
  assert.deepEqual(parse('把刚才那0句标黄'), { error: 'clarify' });
  assert.deepEqual(parse('把「刚刚的」高亮一下'), { operations: [{ type: 'highlight', quote: '刚刚的' }] });
  assert.deepEqual(parse('把刚才引用的那句标黄'), {
    operations: [{ type: 'highlight', target: 'citation', color: '#ffd400' }],
  });
  assert.deepEqual(parse('高亮刚才发送的那句'), { error: 'clarify' });
  for (const question of ['高亮一下刚刚的有什么用？', '怎么高亮刚才的？', '不要高亮刚刚的']) {
    assert.equal(parse(question), null, question);
  }
});

test('a reading question can schedule a Zotero action for its new answer', () => {
  assert.deepEqual(parse('解释这段，再把支撑结论的原句标黄'), {
    kind: 'mixed', question: '解释这段', command: { kind: 'answerHighlight', color: '#ffd400' },
  });
  assert.deepEqual(parse('解释一下这段话，然后把回答存成笔记'), {
    kind: 'mixed', question: '解释一下这段话', command: { operations: [{ type: 'note' }] },
  });
  assert.deepEqual(parse('这句话是什么意思？然后把回答存成 Zotero 笔记'), {
    kind: 'mixed', question: '这句话是什么意思？', command: { operations: [{ type: 'note' }] },
  });
  assert.deepEqual(parse('请解释「原文，再举个例子」，然后把「另一句原文」标蓝'), {
    kind: 'mixed', question: '请解释「原文，再举个例子」',
    command: { operations: [{ type: 'highlight', quote: '另一句原文', color: '#2ea8e5' }] },
  });
  assert.deepEqual(parse('解释「原文」然后高亮标题'), {
    kind: 'mixed', question: '解释「原文」', command: { operations: [{ type: 'paperTitle' }] },
  });
  assert.deepEqual(parse('Explain this sentence, then save the answer as a Zotero note.'), {
    kind: 'mixed', question: 'Explain this sentence', command: { operations: [{ type: 'note' }] },
  });
});

test('quoted, hypothetical, negative, or ambiguous follow-ups do not create mixed writes', () => {
  for (const question of [
    '解释「这句话，然后把摘要标黄」',
    '解释 "this, then highlight the abstract"',
    "Explain 'the phrase, then highlight the abstract'",
    '解释一下如果我想高亮，然后把摘要标黄',
    '如果我说解释一下这段，再把摘要标黄',
    '解释这段，然后不要把摘要标黄',
    '解释这段，然后高亮一下',
    '解释这段，然后可能把摘要标黄',
    '解释这段，然后把刚才提到的原句标黄',
    '解释这段，然后高亮另一篇论文的标题，再把摘要标黄',
    '解释这段，只需要回答，然后把摘要标黄',
  ]) assert.equal(parse(question), null, question);
});

test('polite highlight requests preserve explicit targets and leave questions alone', () => {
  assert.deepEqual(parse('能高亮一下引用2吗？'), { operations: [{ type: 'highlight', citation: 2 }] });
  assert.deepEqual(parse('可以帮我把第二点的证据标黄吗？'), {
    operations: [{ type: 'evidence', point: 2, color: '#ffd400' }],
  });
  assert.deepEqual(parse('能把「刚才提到的原句」高亮一下吗'), {
    operations: [{ type: 'highlight', quote: '刚才提到的原句' }],
  });
  assert.deepEqual(parse('能高亮一下所有关于吸烟的原句吗？'), {
    operations: [{ type: 'topic', topic: '吸烟' }],
  });
  assert.deepEqual(parse('能把另一篇论文的「原句」高亮一下吗？'), { error: 'other-paper' });
  assert.deepEqual(parse('帮我高亮一下，然后写笔记「结果」'), { error: 'clarify' });
  for (const question of [
    '你能高亮一下吗，还是只能跳转？',
    '能高亮吗？',
    '可以高亮吗？',
    '能不能高亮？',
    '可以教我怎么高亮吗？',
    '能不高亮这些证据吗？',
    '请不要高亮这些证据',
    '可以分析这些证据吗？',
    '能把刚才提到的原句高亮一下吗，还是只会跳转？',
  ]) {
    const result = parse(question);
    assert.ok(result === null || result?.error === 'clarify', question);
  }
});

test('distinguishes the original paper title from all section headings', () => {
  for (const [command, type, color] of [
    ['高亮一下标题', 'paperTitle'],
    ['高亮大标题', 'paperTitle'],
    ['把标题标黄', 'paperTitle', '#ffd400'],
    ['高亮论文标题', 'paperTitle'],
    ['标蓝这篇论文的标题', 'paperTitle', '#2ea8e5'],
    ['可以帮我把这篇文章的标题高亮一下吗？', 'paperTitle'],
    ['Highlight the article title in green', 'paperTitle', '#5fb236'],
    ['Can you highlight the title of this paper?', 'paperTitle'],
    ['你能highlight所有标题么', 'paperHeadings'],
    ['高亮所有小标题', 'paperHeadings'],
    ['把文中全部章节标题标紫', 'paperHeadings', '#e56eee'],
    ['Highlight all section headings', 'paperHeadings'],
  ]) {
    assert.deepEqual(parse(command), {
      operations: [{ type, ...(color ? { color } : {}) }],
    }, command);
  }
});

test('title targets require an action and preserve literal and topic targets', () => {
  assert.deepEqual(parse('高亮「论文标题」'), {
    operations: [{ type: 'highlight', quote: '论文标题' }],
  });
  assert.deepEqual(parse('高亮所有关于标题识别的原句'), {
    operations: [{ type: 'topic', topic: '标题识别' }],
  });
  assert.deepEqual(parse('在另一篇论文里高亮标题'), { error: 'other-paper' });
  assert.deepEqual(parse('高亮所有小标题，再写笔记「已读」'), { error: 'clarify' });
  for (const question of [
    '这篇论文标题是什么？',
    '高亮标题有什么用？',
    '怎么高亮所有小标题？',
    '不要高亮标题',
    'How do I highlight the article title?',
  ]) assert.equal(parse(question), null, question);
});

test('abstract highlighting targets the original abstract and supports color', () => {
  for (const [command, color] of [
    ['高亮摘要'],
    ['高亮一下摘要'],
    ['把论文摘要标黄', '#ffd400'],
    ['能把这篇文章的原文摘要标蓝吗？', '#2ea8e5'],
    ['Highlight the abstract'],
    ['Highlight the abstract of this article in green', '#5fb236'],
  ]) {
    assert.deepEqual(parse(command), {
      operations: [{ type: 'paperAbstract', ...(color ? { color } : {}) }],
    }, command);
  }
  assert.deepEqual(parse('高亮「摘要」'), { operations: [{ type: 'highlight', quote: '摘要' }] });
  assert.deepEqual(parse('高亮所有关于摘要写作的句子'), {
    operations: [{ type: 'topic', topic: '摘要写作' }],
  });
  assert.deepEqual(parse('高亮摘要，再写笔记「已读」'), { error: 'clarify' });
  assert.equal(parse('摘要写了什么？'), null);
});

test('undo highlight is separate from undoing an annotation batch', () => {
  for (const command of [
    '撤回这个高亮',
    '撤销刚才的高亮',
    '把这个高亮撤回',
    '能撤回这个高亮吗？',
    'Undo the last highlight',
  ]) assert.deepEqual(parse(command), { operations: [{ type: 'undoHighlight' }] }, command);
  for (const command of ['撤销刚才那一批', '撤销刚才的标注', 'Undo the last annotation batch']) {
    assert.deepEqual(parse(command), { operations: [{ type: 'undo' }] }, command);
  }
  assert.deepEqual(parse('撤回这个高亮，再写笔记「已读」'), { error: 'clarify' });
  assert.equal(parse('怎么撤回这个高亮？'), null);
  assert.equal(parse('为什么这个高亮撤回了？'), null);
});

test('only clear annotation requests with underspecified document targets clarify locally', () => {
  for (const command of ['高亮一下实验方法', '标蓝结果里的关键段落', 'Highlight the Results section', 'Mark the longest passage in purple']) {
    assert.deepEqual(parse(command), { error: 'clarify' }, command);
  }
  for (const question of [
    '高亮一下有什么用？',
    '能不能告诉我怎么高亮结果？',
    '高亮的方法是什么？',
    'How do I highlight the Results section?',
    'Highlight why this works',
    'Highlight how to interpret the table',
    'Highlight the importance of the findings',
  ]) assert.equal(parse(question), null, question);
});

test('scans the current paper for explicit Chinese and English topic commands', () => {
  for (const [command, topic, color] of [
    ['高亮所有关于吸烟和缺失的原句', '吸烟和缺失'],
    ['高亮所有关于验证结果的', '验证结果'],
    ['请高亮全文所有关于测序精度的句子', '测序精度'],
    ['把所有关于 smoking 的内容标黄', 'smoking', '#ffd400'],
    ['把关于“long-read sequencing”那几句标蓝', 'long-read sequencing', '#2ea8e5'],
    ['高亮关于「accuracy, recall, and precision」的段落', 'accuracy, recall, and precision'],
    ['Highlight every sentence about sequence coverage in green', 'sequence coverage', '#5fb236'],
    ['Highlight all passages mentioning validation', 'validation'],
  ]) {
    assert.deepEqual(parse(command), {
      operations: [{ type: 'topic', topic, ...(color ? { color } : {}) }],
    }, command);
  }
});

test('topic searches do not run alongside other writes or as ordinary analysis', () => {
  for (const command of [
    '高亮所有关于吸烟的原句，批注写「核对样本」',
    '高亮所有关于吸烟的原句，然后写笔记「结果」',
    '给所有关于吸烟的原句加批注「核对样本」',
    '把所有关于「」的原句标蓝',
  ]) assert.deepEqual(parse(command), { error: 'clarify' }, command);
  assert.deepEqual(parse('在另一篇论文里高亮所有关于吸烟的原句'), { error: 'other-paper' });
  assert.deepEqual(parse('Highlight every sentence about smoking in all papers'), { error: 'other-paper' });
  for (const question of [
    '所有关于吸烟和缺失的原句是什么？',
    '高亮所有关于吸烟的原句会发生什么？',
    'How do I highlight all sentences about smoking?',
    'Which sentences about smoking should I highlight?',
  ]) assert.equal(parse(question), null, question);
});

test('chains evidence, a verbatim comment, and note capture in order', () => {
  assert.deepEqual(parse('把第 2 点的证据标出来，并批注写「核对样本量」，再把这条回答存成笔记'), {
    operations: [
      { type: 'evidence', point: 2, comment: '核对样本量' },
      { type: 'note' },
    ]
  });
});

test('handles native comments, note capture, recolor, and batch undo', () => {
  assert.deepEqual(parse('批注写核对样本量'), {
    operations: [{ type: 'highlight', comment: '核对样本量' }]
  });
  assert.deepEqual(parse('在「原句」上加批注写「复核。」'), {
    operations: [{ type: 'highlight', quote: '原句', comment: '复核。' }]
  });
  assert.deepEqual(parse('请把这条回答存成笔记'), { operations: [{ type: 'note' }] });
  assert.deepEqual(parse('写笔记『进一步核对』'), {
    operations: [{ type: 'note', text: '进一步核对' }]
  });
  assert.deepEqual(parse('把刚才的高亮改蓝'), {
    operations: [{ type: 'recolor', color: '#2ea8e5' }]
  });
  assert.deepEqual(parse('撤销刚才那一批'), { operations: [{ type: 'undo' }] });
});

test('captures notes from practical Chinese commands and explicit sources', () => {
  for (const words of ['做个笔记', '写个笔记', '记一下', '可以帮我做个笔记吗？']) {
    assert.deepEqual(parse(words), {operations: [{type: 'note'}]}, words);
  }
  assert.deepEqual(parse('写个笔记「核对样本量」'), {operations: [{type: 'note', text: '核对样本量'}]});
  assert.deepEqual(parse('记一下：检查外部验证'), {operations: [{type: 'note', text: '检查外部验证'}]});
  for (const [words, target] of [
    ['摘要存为笔记', 'abstract'],
    ['把这篇论文的摘要存成笔记', 'abstract'],
    ['保存论文摘要为笔记', 'abstract'],
    ['把回答存为笔记', 'answer'],
    ['把选段存为笔记', 'selection'],
    ['能把我选中的这句存为笔记吗？', 'selection'],
    ['Save the selected text as a note', 'selection'],
  ]) assert.deepEqual(parse(words), {operations: [{type: 'note', target}]}, words);
  assert.deepEqual(parse('解释这段，再保存'), {
    kind: 'mixed', question: '解释这段', command: {operations: [{type: 'note'}]},
  });
});

test('abstract summary asks a new question and respects the requested note location', () => {
  assert.deepEqual(parse('把摘要写了什么总结成笔记写在摘要的旁边分成几点'), {
    kind: 'mixed', question: '请仅根据这篇论文的摘要，用几点概括摘要内容。',
    command: {operations: [{type: 'paperAbstract', commentFromAnswer: true}]},
  });
  assert.deepEqual(parse('把摘要总结成笔记'), {
    kind: 'mixed', question: '请仅根据这篇论文的摘要，概括摘要内容。',
    command: {operations: [{type: 'note'}]},
  });
  assert.deepEqual(parse('帮我把这篇论文的摘要整理成笔记，再贴在摘要旁边，分成三点'), {
    kind: 'mixed', question: '请仅根据这篇论文的摘要，用 3 点概括摘要内容。',
    command: {operations: [{type: 'paperAbstract', commentFromAnswer: true}]},
  });
  for (const words of [
    '摘要写了什么？',
    '如果我说把摘要总结成笔记，会发生什么？',
    '「把摘要总结成笔记」',
    '不要把摘要总结成笔记',
    '把摘要总结成笔记，不要写在摘要旁边',
  ]) assert.equal(parse(words), null, words);
});

test('comments and underlines accept explicit original quotes or the current selection', () => {
  assert.deepEqual(parse('给选中的这句加个批注「样本量待核对」'), {
    operations: [{type: 'highlight', target: 'selection', comment: '样本量待核对'}],
  });
  assert.deepEqual(parse('给「原句」写个批注：看图二'), {
    operations: [{type: 'highlight', quote: '原句', comment: '看图二'}],
  });
  assert.deepEqual(parse('加个批注「结果需核对」'), {
    operations: [{type: 'highlight', comment: '结果需核对'}],
  });
  assert.deepEqual(parse('给选中的这句加下划线'), {
    operations: [{type: 'highlight', mark: 'underline', target: 'selection'}],
  });
  assert.deepEqual(parse('下划线标出引用1'), {
    operations: [{type: 'highlight', mark: 'underline', citation: 1}],
  });
  assert.deepEqual(parse('Underline "The original sentence."'), {
    operations: [{type: 'highlight', mark: 'underline', quote: 'The original sentence.'}],
  });
  assert.deepEqual(parse('解释这段，再给选段加下划线'), {
    kind: 'mixed', question: '解释这段',
    command: {operations: [{type: 'highlight', mark: 'underline', target: 'selection'}]},
  });
});

test('unquoted note and comment bodies retain punctuation and newlines after a colon', () => {
  const text = '结果里的「样本量」需要核对，先不下结论。\n下一轮看图二。';
  assert.deepEqual(parse('写个笔记：' + text), {operations: [{type: 'note', text}]});
  assert.deepEqual(parse('加个批注：' + text), {operations: [{type: 'highlight', comment: text}]});
  assert.deepEqual(parse('给摘要写个批注：' + text), {operations: [{type: 'paperAbstract', comment: text}]});
  assert.deepEqual(parse('高亮引用1，写个批注：' + text), {
    operations: [{type: 'highlight', citation: 1, comment: text}],
  });
  assert.deepEqual(parse('加个批注：会不会存在测量偏差？'), {
    operations: [{type: 'highlight', comment: '会不会存在测量偏差？'}],
  });
  assert.deepEqual(parse('写个笔记：「先记下来」，再给选段加下划线'), {
    operations: [{type: 'note', text: '先记下来'}, {type: 'highlight', mark: 'underline', target: 'selection'}],
  });
});

test('existing note edits require an explicit command and delimited content', () => {
  assert.deepEqual(parse('往笔记「要点」里追加「样本要核对」'), {
    operations: [{type: 'noteAppend', title: '要点', text: '样本要核对'}],
  });
  assert.deepEqual(parse('在现有笔记里追加：核对图三'), {
    operations: [{type: 'noteAppend', text: '核对图三'}],
  });
  assert.deepEqual(parse('把笔记「要点」的内容改成「完整正文」'), {
    operations: [{type: 'noteReplace', title: '要点', text: '完整正文'}],
  });
  assert.deepEqual(parse('把笔记「要点」改成「正文」，再给选段加下划线'), {error: 'clarify'});
  for (const words of [
    '怎么写个笔记？', '写个笔记需要什么格式？', '能写笔记吗？',
    '写个笔记会不会影响原文？', '给选段加个批注会不会同步？',
    '为什么要加个批注？', '给选中的这句加下划线有什么用？',
    '不要给选中的这句加下划线', '「加个批注」',
    '怎样往笔记「要点」里追加一段？', '如果我说往笔记里追加「样本要核对」',
  ]) assert.equal(parse(words), null, words);
  assert.deepEqual(parse('往笔记「要点」里追加「」'), {error: 'clarify'});
  assert.deepEqual(parse('写个笔记到另一篇论文下面'), {error: 'other-paper'});
});

test('allows concise English commands without treating questions as writes', () => {
  assert.deepEqual(parse('Highlight "The treatment, overall, worked." in yellow; add comment: "Review sample size."'), {
    operations: [{ type: 'highlight', quote: 'The treatment, overall, worked.', color: '#ffd400', comment: 'Review sample size.' }]
  });
  assert.deepEqual(parse('Save this answer as a Zotero note'), { operations: [{ type: 'note' }] });
  assert.deepEqual(parse('Recolor the last highlight to green'), {
    operations: [{ type: 'recolor', color: '#5fb236' }]
  });
  assert.deepEqual(parse('Undo the last annotation batch'), { operations: [{ type: 'undo' }] });
  assert.equal(parse('How do I highlight this passage?'), null);
});

test('asks for clarification instead of performing a partial or uncertain write', () => {
  for (const value of [
    '把「确定句子」高亮，再加一个我没说清楚的东西',
    '高亮「」',
    '批注写「」',
    '把引用0高亮',
    '把第0点的证据标出来',
    '把作者结论的所有证据标出来',
    '撤销刚才，写笔记「不同操作」',
    '写笔记「没闭合',
  ]) assert.deepEqual(parse(value), { error: 'clarify' }, value);
});

test('recognizes explicit capability questions about writing Zotero annotations', () => {
  for (const value of ['没办法编辑zotero么', '能直接编辑 Zotero 吗？', 'Ask GPT 能在 Zotero 里做标注吗？',
    'Can you edit Zotero?', "Can't you add annotations in Zotero?"]) {
    assert.deepEqual(parse(value), {kind: 'capabilities'}, value);
  }
});

test('a casual retry still requests native highlighting', () => {
  assert.deepEqual(parse('再试试高亮一下'), {kind: 'contextHighlight'});
  assert.deepEqual(parse('再试试把引用1标黄'),
    {operations: [{type: 'highlight', citation: 1, color: '#ffd400'}]});
  assert.equal(parse('再试试解释这句话'), null);
});

test('leaves ordinary paper questions and questions about annotation untouched', () => {
  for (const value of [
    '这句话是什么意思？',
    '分析作者认为需要高亮的证据',
    '这个结论的证据是什么？',
    '第2点的证据靠谱吗？',
    '把这个结论的证据找出来',
    'What evidence supports point 2?',
    '怎么把这条回答存成笔记？',
    '写笔记需要多长时间',
    '批注写什么好',
    '高亮是不是有用',
    '我已经有一条批注了，怎么看?',
    '为什么 Zotero 的高亮不同步？',
    'Can you rewrite the text of this PDF?',
    '如果我说“把引用2高亮”，会发生什么？',
    '他是在说另一篇论文吗？',
    '在另一篇论文里，高亮是怎么处理的？',
    '在另一篇论文里，作者提到了相同的机制吗？',
  ]) assert.equal(parse(value), null, value);
});

test('does not apply cross-paper commands to the current paper', () => {
  for (const value of [
    '把另一篇论文的「这句话」标黄',
    '把另一篇论文的第2点证据标出来',
    'Mark the evidence for conclusion 2 in another paper',
    '在《另一本研究》中高亮「原句」',
    '把这条回答存成笔记，再移到其他论文',
    'Highlight "This quote" in another paper',
    '把这条回答存到 DOI 10.1000/test',
  ]) assert.deepEqual(parse(value), { error: 'other-paper' }, value);
  assert.deepEqual(parse('写笔记「和《另一篇论文》比较」'), {
    operations: [{ type: 'note', text: '和《另一篇论文》比较' }]
  });
});
