(function (root) {
  'use strict';

  const colors = {
    黄: '#ffd400', 蓝: '#2ea8e5', 绿: '#5fb236', 紫: '#e56eee', 红: '#ff6666',
    yellow: '#ffd400', blue: '#2ea8e5', green: '#5fb236', purple: '#e56eee', red: '#ff6666'
  };
  const chineseColor = '[黄蓝绿紫红]';
  const englishColor = 'yellow|blue|green|purple|red';
  const quoteMark = '\\uE000(\\d+)\\uE001';
  const quotePairs = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\r\n]*"/gu;
  const digits = '〇一二三四五六七八九';
  const indexWord = '[0-9]{1,2}|[一二三四五六七八九十]{1,3}';
  const citationIndex = new RegExp('^(?:引用|出处|citation|source)\\s*[#＃]?\\s*(' + indexWord +
    ')$|^第\\s*(' + indexWord + ')\\s*条?(?:引用|出处)$', 'iu');
  const evidencePoint = new RegExp('^第\\s*(' + indexWord +
    ')\\s*(?:点|[条个]结论)(?:的)?证据$|^(?:the )?evidence (?:for|supporting) (?:point|conclusion)\\s*#?(' + indexWord + ')$', 'iu');
  const currentEvidence = /^(?:(?:[这那](?:个|条)?|该|刚才的|上一条)结论(?:的)?证据|(?:the )?evidence (?:for|supporting) (?:this|that|the last) conclusion)$/iu;
  const quoted = new RegExp('^' + quoteMark + '$', 'u');
  const currentSelection = /^(?:(?:当前)?选段|当前划词|(?:我)?(?:现在|当前)?选中(?:的)?(?:文字|文本|选段|这(?:句|段)(?:话)?)|划选(?:的)?(?:文字|句子|段落)|(?:the )?(?:current selection|selected text))$/iu;
  const lastCitation = /^(?:(?:你)?(?:刚才|上面|上一(?:条|轮))(?:所)?引用(?:的)?(?:[那这]一?(?:句|段)(?:话)?|原句|原文)|(?:刚才|上面|上一条)(?:的)?(?:引用|出处)|(?:the )?(?:last|previous) (?:citation|quote)|(?:the )?(?:sentence|passage) you (?:just )?(?:cited|quoted))$/iu;
  const recentAnswerReference = new RegExp('^(?:你\\s*)?(?:刚刚|刚才|上面|上一(?:条|轮))' +
    '(?:\\s*(?:所)?(?:提到|说到|提及|列出|推荐|选出))?(?:\\s*的)?' +
    '(?:\\s*[这那]?\\s*(' + indexWord + '|两|几)?\\s*[句段条](?:话|原句|原文|证据)?|\\s*(?:原句|原文|句子|段落|证据|结论))?(?:\\s*都)?$', 'u');
  const answerReference = /^(?:[这那]些(?:证据|原句|出处)(?:\s*都)?|(?:the )?(?:sentence|passage) you (?:just )?mentioned|these (?:excerpts|passages|citations))$/iu;
  const unclearRecentReference = /^(?:刚刚|刚才|上面|前面|之前).{1,24}(?:的|[句段条]|话|证据|原文|原句)$/u;
  const unclearChineseLocation = /^.{0,28}(?:章节|小节|标题|摘要|段落|原句|句子|原文|表格|图注|实验方法|结果|结论|证据)(?:\s*都)?$/u;
  const unclearEnglishLocation = /^(?:[\p{L}\p{N}][\p{L}\p{N}'’-]*\s+){0,8}(?:sections?|headings?|paragraphs?|passages?|sentences?|lines?|figures?|tables?|captions?)(?:\s+[0-9]{1,3})?$/iu;
  const bareHighlight = new RegExp('^(?:高亮|标亮|标(' + chineseColor + ')(?:色)?)(\\s*一下)?$', 'u');
  const chineseHighlight = new RegExp('^(?:把|将)\\s*(.+?)\\s*(?:(?:用|成)\\s*(' + chineseColor +
    ')(?:色)?\\s*高亮|标(?:记为|注为|成|为)?\\s*(' + chineseColor + ')(?:色)?|(?:高亮|标记)(?:一下)?|标亮|标(?:注)?出(?:来)?)$|^(?:(?:高亮|标亮|标记|标(?:注)?出(?:来)?)\\s*(?:一下)?|标(' +
    chineseColor + ')(?:色)?)\\s*(.+)$', 'u');
  const englishHighlight = /^(?:highlight|mark)(?:\s+|(?=\p{Script=Han}))(.+?)(?:\s+in\s+(yellow|blue|green|purple|red))?$/iu;
  const paperTitle = /^(?:(?:(?:(?:这|该|本|当前)(?:一?篇)?)?(?:论文|文章|文献)|(?:这|该|本)篇)\s*的?\s*)?(?:(?:主|大)?标题|题目)$|^(?:(?:the\s+)?(?:(?:paper|article)\s+)?title|(?:the\s+)?title\s+of\s+(?:this|the)\s+(?:paper|article)|(?:this|the)\s+(?:paper|article)['’]s\s+title)$/iu;
  const paperHeadings = /^(?:(?:全文|文中|这篇论文[中里])\s*)?(?:所有|全部|各个|每个)\s*的?\s*(?:小标题|章节标题|小节标题|标题)$|^(?:all(?:\s+the)?\s+(?:(?:section|chapter)\s+)?(?:headings|subheadings|titles)|every\s+(?:(?:section|chapter)\s+)?(?:heading|subheading|title)|(?:the\s+)?(?:section|chapter)\s+headings)$/iu;
  const genericTarget = /^(?:[这那](?:一)?(?:句|段)(?:话|原文)?|(?:当前|这)(?:个)?选段|(?:这|那)(?:条)?原句|this (?:sentence|passage|quote))$/iu;
  const paperAbstract = /^(?:(?:(?:这|该|本|当前)(?:一?篇)?)?(?:论文|文章|文献)\s*的?\s*)?(?:整个|整段)?(?:原文)?摘要$|^(?:(?:the\s+)?(?:(?:paper|article)\s+)?abstract|(?:the\s+)?abstract\s+of\s+(?:this|the)\s+(?:paper|article)|(?:this|the)\s+(?:paper|article)['’]s\s+abstract)$/iu;
  const highlightToUndo = '(?:(?:[这那][个次条]|刚刚|刚才|上一[次个条]|上次|最后一次)\\s*的?\\s*)?高亮(?:标注)?';
  const undoHighlight = new RegExp('^(?:(?:撤回|撤销|取消)\\s*' + highlightToUndo +
    '|(?:把|将)\\s*' + highlightToUndo + '\\s*(?:撤回|撤销|取消)|undo\\s+(?:the\\s+)?(?:last|previous|this)\\s+highlights?)$', 'iu');
  const answer = '(?:[这那]一?(?:条|轮|份)(?:回答|回复|总结)|(?:你)?(?:刚才|上一条|上一轮)(?:的)?(?:回答|回复|总结)|当前回答|本轮总结)';
  const noteAmount = '(?:(?:一)?[个条份])?';
  const noteDestination = '(?:为|成|作)\\s*' + noteAmount + '\\s*(?:Zotero\\s*)?笔记';
  const toNote = '\\s*(?:保存|存|记)(?:' + noteDestination +
    '|(?:进|到|在)\\s*(?:(?:这篇|当前)(?:论文|文章)(?:的)?(?:下(?:面)?|笔记(?:里)?)?|Zotero(?:笔记)?))$';
  const saveAnswer = new RegExp('^(?:把|将)?\\s*' + answer + toNote, 'iu');
  const saveNewAnswer = new RegExp('^(?:把|将)?\\s*(?:(?:这次|本次|你的)\\s*(?:的)?\\s*)?(?:回答|解释|总结)' +
    toNote + '|^save (?:the|your) (?:answer|reply|summary) (?:as (?:a )?(?:Zotero )?note|to (?:this paper|Zotero))$', 'iu');
  const saveNoteSource = new RegExp('^(?:把|将)?\\s*(.+?)' + toNote +
    '|^(?:保存|摘录|记录)\\s*(.+?)\\s*' + noteDestination +
    '$|^save\\s+(.+?)\\s+as (?:a )?(?:Zotero )?note$', 'iu');
  const noteHeader = '(?:(?:新建|写|做|记下|加|保存)' + noteAmount + '\\s*(?:Zotero\\s*)?笔记|(?:create|write|add) (?:a )?(?:Zotero )?note)';
  const noteDetails = '(?:\\s*(?:内容(?:是|为)?|写))?';
  const noteProse = new RegExp('^' + noteHeader + noteDetails + '\\s*[:：]?\\s*(.*)$', 'iu');
  const quickNote = /^(?:记|记录)一下\s*(?:[:：]\s*(.*)|(\uE000\d+\uE001)|吧)?$/u;
  const commentHeader = '(?:批注(?:写|填|内容(?:是|为)?)|(?:写|加)(?:(?:一)?[个条])?批注|add (?:a )?comment|comment)';
  const commentProse = new RegExp('^(?:' + commentHeader + '|批注(?=\\s*[:：]))\\s*[:：]?\\s*(.*)$', 'iu');
  const commentAnchor = '(?:给|在)\\s*(.+?)\\s*(?:上)?\\s*(?:加|写)(?:(?:一)?[个条])?批注(?:写|内容(?:为|是)?)?';
  const anchoredComment = new RegExp('^' + commentAnchor + '\\s*[:：]?\\s*(.*)$', 'u');
  const underline = /^(?:(?:给|在)\s*(.+?)\s*(?:上)?\s*加(?:一?条)?下划线|(?:把|将)\s*(.+?)\s*(?:加(?:一?条)?下划线|用下划线标(?:记|出(?:来)?))|(?:用)?下划线(?:标(?:记|出(?:来)?))?\s*(.+)|underline\s+(.+))$/iu;
  const noteAppendHeader = '(?:往|在|向)\\s*(?:现有(?:的)?)?笔记\\s*(\\uE000\\d+\\uE001)?\\s*(?:里|中|末尾)?\\s*(?:追加|补充|添加)';
  const noteReplaceHeader = '(?:把|将)\\s*(?:现有(?:的)?)?笔记\\s*(\\uE000\\d+\\uE001)?\\s*(?:的(?:全文|正文|内容))?\\s*(?:改成|改为|替换为|重写为)';
  const noteEditPayload = '\\s*(?:[:：]\\s*(.*)|(\\uE000\\d+\\uE001))$';
  const noteAppend = new RegExp('^' + noteAppendHeader + noteEditPayload, 'u');
  const noteReplace = new RegExp('^' + noteReplaceHeader + noteEditPayload, 'u');
  const delimitedProse = new RegExp('^(?:' + noteHeader + noteDetails + '|(?:记|记录)一下|' +
    commentHeader + '|批注|' + commentAnchor + '|' + noteAppendHeader + '|' + noteReplaceHeader + ')$', 'iu');
  const proseQuestion = /^(?:需要什么|需不需要|要不要|要怎么|能不能|可不可以|会不会|是什么|有用吗)/u;
  const commandSeparator = /[，,；;。\r\n]+|(?:然后|并且|再|并)(?=(?:把|将|给|批注写|写笔记))/u;
  const abstractSummary = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|可以|能不能|先)\s*)*(?:把|将)?\s*(?:(?:这|该|本)篇(?:论文|文章)\s*的?)?\s*(?:原文)?摘要(?:\s*(?:内容|写了什么))?\s*(?:总结|概括|归纳|整理)(?:一下)?\s*(?:成|为|作)\s*(?:(?:一)?[条份个])?\s*(?:Zotero\s*)?笔记(?:[，,；;\s]*(?:再|然后|接着|并)?\s*(写|贴|放|加|标)\s*在\s*摘要\s*的?\s*(?:旁边|旁|边上))?(?:[，,；;\s]*(?:分|列)(?:成|为)?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3}|两|几)\s*点)?$/iu;
  const newAnswerSupport = /^(?:(?:支撑|支持|佐证)(?:(?:这(?:个|次的)|该|上述|你的))?结论(?:的)?(?:原句|原文|原文段落|证据)|(?:the\s+)?(?:supporting\s+(?:quotes?|passages?|evidence)|(?:quotes?|sentences?|passages?)\s+(?:supporting|that\s+support)\s+(?:this|the)\s+conclusion))$/iu;
  const otherPaper = /(?:《[^》]+》|另一篇|别的(?:论文|文章|文献)|其他(?:论文|文章|文献)|上(?:一|次那)篇(?:论文|文章)|下一篇(?:论文|文章)|所有(?:论文|文章|文献)|多篇(?:论文|文章|文献)|\b(?:another|other|different) (?:paper|article)\b|\bin all (?:papers|articles|documents|PDFs)\b|\b10\.\d{4,9}\/)/iu;
  const chineseTopic = /^(?:(?:全文|文中|这篇论文[中里]?)\s*)?(?:所有|全部)?\s*(?:关于|涉及)\s*(.+?)(?:\s*(?:的\s*(?:(?:所有|全部)?\s*(?:原句|句子|内容|段落|证据|(?:这|那)几句))?|(?:这|那)几句))?$/u;
  const englishTopic = /^(?:(?:every|each) (?:sentence|passage|mention)|all (?:the )?(?:sentences|passages|mentions|content|statements))\s+(?:about|of|mentioning|related to)\s+(.+)$/iu;

  function citationNumber(value) {
    if (/^\d+$/u.test(value)) return Number(value);
    if (value.length === 1 && value !== '十') return digits.indexOf(value);
    const parts = value.split('十');
    if (parts.length !== 2 || parts.some(part => part.length > 1)) return 0;
    return (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0);
  }

  function answerTarget(text) {
    const recent = recentAnswerReference.exec(text);
    if (!recent && !answerReference.test(text)) return null;
    const quantity = recent?.[1];
    if (!quantity || quantity === '几') return { type: 'answerHighlight' };
    const count = quantity === '两' ? 2 : citationNumber(quantity);
    return count > 0 && count <= 99 ? { type: 'answerHighlight', count } : { error: 'clarify' };
  }

  function target(value, literals) {
    const reference = value.trim();
    const match = quoted.exec(reference);
    if (match) {
      const quote = literals[Number(match[1])];
      return quote?.trim() ? { quote } : null;
    }
    const index = citationIndex.exec(reference);
    if (index) {
      const citation = citationNumber(index[1] || index[2]);
      return citation > 0 && citation <= 99 ? { citation } : null;
    }
    const numberedEvidence = evidencePoint.exec(reference);
    if (numberedEvidence) {
      const point = citationNumber(numberedEvidence[1] || numberedEvidence[2]);
      return point > 0 && point <= 99 ? { type: 'evidence', point } : null;
    }
    if (currentEvidence.test(reference)) return { type: 'evidence' };
    if (currentSelection.test(reference)) return { target: 'selection' };
    if (lastCitation.test(reference)) return { target: 'citation' };
    if (genericTarget.test(reference)) return {};
    if (paperTitle.test(reference)) return { type: 'paperTitle' };
    if (paperHeadings.test(reference)) return { type: 'paperHeadings' };
    if (paperAbstract.test(reference)) return { type: 'paperAbstract' };
    const topicMatch = chineseTopic.exec(reference) || englishTopic.exec(reference);
    if (topicMatch) {
      const topic = literal(topicMatch[1], literals)?.trim();
      if (topic && topic.length <= 256 && !/^(?:的|原句|句子|内容|段落|证据)$/u.test(topic)) {
        return { type: 'topic', topic };
      }
      return { error: 'clarify' };
    }
    return null;
  }

  function literal(value, literals) {
    const text = value.trim();
    const token = quoted.exec(text);
    if (token) return literals[Number(token[1])];
    // Quoted arguments have a single owner. Mixed prose is ambiguous.
    return /[\uE000\uE001「」『』“”‘’"]/u.test(text) ? null : text;
  }

  function noteSource(value) {
    const match = saveNoteSource.exec(value);
    if (!match) return null;
    const source = (match[1] || match[2] || match[3]).trim();
    if (currentSelection.test(source)) return 'selection';
    if (paperAbstract.test(source)) return 'abstract';
    if (saveNewAnswer.test(value) || /^(?:this|the|your)\s+(?:answer|reply|summary)$/iu.test(source)) return 'answer';
    return null;
  }

  function informational(value) {
    return !/[\uE000\uE001:：]/u.test(value) &&
      /(?:写什么|什么是|有什么|会发生什么|如何|怎么|为什么|为何|是不是|是否|需要多长|多久|[吗么]$)/u.test(value);
  }

  function atom(value, literals, afterQuestion) {
    if (informational(value)) return null;
    const bare = bareHighlight.exec(value);
    if (bare) return bare[1] ? { type: 'contextHighlight', color: colors[bare[1]] } : { type: 'contextHighlight' };
    if (undoHighlight.test(value)) return { type: 'undoHighlight' };
    if (/^(?:撤销(?:\s*(?:刚才(?:的)?(?:那一批|那批|一批|标注|操作)?|上一次(?:的)?(?:标注|操作)))?|undo (?:the )?(?:last(?: annotation batch| action)?|previous batch))$/iu.test(value)) {
      return { type: 'undo' };
    }
    const recolor = value.match(new RegExp('^(?:把|将)\\s*(?:刚才|上(?:一|次))(?:的)?\\s*(?:高亮|标注)(?:改(?:成|为)?|换(?:成|为)?)\\s*(' +
      chineseColor + ')(?:色)?$|^(?:recolou?r|change (?:the )?colou?r of) (?:the )?last (?:highlight|annotation)(?: to)? (' + englishColor + ')$', 'iu'));
    if (recolor) return { type: 'recolor', color: colors[(recolor[1] || recolor[2]).toLowerCase()] };

    if (afterQuestion && (saveNewAnswer.test(value) || /^(?:保存|保存一下|存一下)$/u.test(value)) || saveAnswer.test(value) ||
        /^save (?:this|the (?:last|previous)) (?:answer|reply|summary) (?:as (?:a )?(?:Zotero )?note|to (?:this paper|Zotero))$/iu.test(value)) {
      return { type: 'note' };
    }
    const source = noteSource(value);
    if (source) return { type: 'note', target: source };
    const append = noteAppend.exec(value);
    const edit = append || noteReplace.exec(value);
    if (edit) {
      const title = edit[1] && literal(edit[1], literals)?.trim();
      const text = literal(edit[2] ?? edit[3], literals);
      if (!text?.trim() || edit[1] && !title) return { error: 'clarify' };
      const type = append ? 'noteAppend' : 'noteReplace';
      return title ? { type, title, text } : { type, text };
    }
    const quick = quickNote.exec(value), note = noteProse.exec(value);
    if (quick || note) {
      const body = quick ? quick[1] ?? quick[2] : note[1];
      if (body === undefined || note && !/[:：]\s*$/u.test(value) && (!body.trim() || /^[吧嘛]$/u.test(body))) return { type: 'note' };
      if (proseQuestion.test(body)) return null;
      if (/^(?:到|在|给|进)/u.test(body) && otherPaper.test(body)) return { error: 'other-paper' };
      const text = literal(body, literals);
      return text?.trim() ? { type: 'note', text } : { error: 'clarify' };
    }

    const comment = commentProse.exec(value);
    if (comment) {
      if (proseQuestion.test(comment[1])) return null;
      const text = literal(comment[1], literals);
      return text?.trim() ? { type: 'comment', comment: text } : { error: 'clarify' };
    }
    const anchored = anchoredComment.exec(value);
    if (anchored) {
      if (proseQuestion.test(anchored[2])) return null;
      const reference = target(anchored[1], literals);
      const text = literal(anchored[2], literals);
      return reference && !reference.error &&
        (!reference.type || ['evidence', 'paperTitle', 'paperAbstract'].includes(reference.type)) && text?.trim()
        ? { type: 'highlight', ...reference, comment: text } : { error: 'clarify' };
    }
    const underscored = underline.exec(value);
    if (underscored) {
      const reference = target(underscored.slice(1).find(Boolean), literals);
      return reference && !reference.error && !reference.type
        ? { type: 'highlight', ...reference, mark: 'underline' } : { error: 'clarify' };
    }

    const chinese = chineseHighlight.exec(value);
    const english = englishHighlight.exec(value);
    if (!chinese && !english) return null;
    const referenceText = (chinese ? chinese[1] || chinese[5] : english[1]).trim();
    const reference = afterQuestion && newAnswerSupport.test(referenceText)
      ? { type: 'answerHighlight' } : target(referenceText, literals) || answerTarget(referenceText);
    // Prefix phrases such as 高亮标注是什么 are ordinary conversation.
    if (!reference) {
      const unclearLocation = chinese
        ? chinese[1] || unclearRecentReference.test(referenceText) || unclearChineseLocation.test(referenceText)
        : !/^(?:how|why|what|whether|which|when|where|who)\b/iu.test(referenceText) &&
          (english[2] || unclearEnglishLocation.test(referenceText));
      return unclearLocation || /[\uE000\uE001]/u.test(value) ? { error: 'clarify' } : null;
    }
    if (reference.error) return reference;
    const name = chinese ? chinese[2] || chinese[3] || chinese[4] : english[2]?.toLowerCase();
    return name ? { type: 'highlight', ...reference, color: colors[name] } : { type: 'highlight', ...reference };
  }

  function normalizePhrase(phrase) {
    const value = phrase.trim()
      .replace(/^(?:然后|并且|并|再|and then\b|and\b|then\b)\s*/iu, '')
      .replace(/[.！!？?]+$/u, '').trim();
    const polite = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|(?:再)?试试|(?:你\s*)?(?:能不能|可不可以|可以|能))\s*)+/u.exec(value);
    if (polite) {
      const command = value.slice(polite[0].length).replace(/\s*[吗么]$/u, '').trim();
      const bare = bareHighlight.exec(command);
      if (bare && !bare[1] && !bare[2] && !/(?:请|麻烦|帮我|试试)/u.test(polite[0])) return value;
      if (bare || chineseHighlight.test(command) || englishHighlight.test(command) || undoHighlight.test(command)) return command;
      if (noteSource(command) || saveAnswer.test(command) || noteAppend.test(command) || noteReplace.test(command) ||
          anchoredComment.test(command) || underline.test(command)) return command;
      if (noteProse.test(command) || quickNote.test(command) || commentProse.test(command)) {
        return /(?:请|麻烦|帮我|试试)/u.test(polite[0]) ? command : value;
      }
    }
    return value.replace(/^(?:请|麻烦|帮我|能不能|可以|please\b|could you\b|can you\b)\s*/iu, '');
  }

  function parseCommand(input, afterQuestion = false) {
    const question = input.trim().replace(/[?？。]+$/u, '').trim();
    const localCapabilities = /^(?:(?:你|Ask(?: for)? GPT|这个面板|插件)\s*)?(?:没办法|不能|无法|能不能|可不可以|能|可以)\s*(?:直接\s*)?(?:(?:编辑|操作|写入)\s*Zotero|在\s*Zotero\s*(?:里|中)?\s*(?:做|加|保存|写入)?\s*(?:标注|高亮|批注|笔记))\s*[吗么嘛]?$/iu;
    const englishCapabilities = /^(?:can|could|can['’]t|cannot)\s+(?:you|Ask(?: for)? GPT|this panel)\s+(?:edit\s+Zotero|(?:add|save)\s+(?:annotations?|highlights?|notes?)\s+(?:in|to)\s+Zotero)$/iu;
    if (localCapabilities.test(question) || englishCapabilities.test(question)) return {kind: 'capabilities'};
    const literals = [], pairs = [];
    const mask = value => '\uE000' + (literals.push(value) - 1) + '\uE001';
    let surface = input.replace(quotePairs, pair => {
      pairs.push(pair);
      return mask(pair.slice(1, -1));
    });
    for (const {index} of surface.matchAll(/[:：]/gu)) {
      const header = surface.slice(0, index).split(commandSeparator).at(-1);
      if (!delimitedProse.test(normalizePhrase(header))) continue;
      const content = surface.slice(index + 1).trim();
      if (!content || content.startsWith('\uE000')) continue;
      const text = content.replace(/\uE000(\d+)\uE001/gu, (_, pairIndex) => pairs[Number(pairIndex)]);
      surface = surface.slice(0, index + 1) + mask(text);
      break;
    }
    const phrases = surface.split(commandSeparator)
      .map(normalizePhrase).filter(Boolean);
    if (!phrases.length) return null;

    const operations = [];
    for (const phrase of phrases) {
      if (otherPaper.test(phrase) && (operations.length ||
          !informational(phrase) && /^(?:(?:在|把|将|给).*(?:高亮|标[黄蓝绿紫红]|标(?:注)?出|写批注|加批注|批注写|存(?:成|为|到)|保存)|高亮|标[黄蓝绿紫红]|标(?:注)?出|highlight\b|mark\b|save\b|add\b)/iu.test(phrase))) {
        return { error: 'other-paper' };
      }
      const command = atom(phrase, literals, afterQuestion);
      if (!command) return operations.length ? { error: 'clarify' } : null;
      if (command.error) return command;
      if (command.type === 'comment') {
        const last = operations.at(-1);
        if (['highlight', 'evidence'].includes(last?.type) && !last.comment) last.comment = command.comment;
        else operations.push({ type: 'highlight', comment: command.comment });
      } else {
        operations.push(command);
      }
    }
    const contextual = operations.find(op => op.type === 'contextHighlight' || op.type === 'answerHighlight');
    if (operations.length > 12 || operations.length > 1 && (contextual ||
        operations.some(op => ['undo', 'undoHighlight', 'recolor', 'topic', 'paperTitle', 'paperHeadings', 'paperAbstract',
          'noteAppend', 'noteReplace'].includes(op.type)))) {
      return { error: 'clarify' };
    }
    if (contextual) {
      const {type: kind, ...details} = contextual;
      return { kind, ...details };
    }
    return { operations };
  }

  function parseMixed(input) {
    const mask = quote => '\uE002'.repeat(quote.length);
    const surface = input.replace(quotePairs, mask)
      .replace(/(?<![\p{L}\p{N}])'[^'\r\n]*'(?![\p{L}\p{N}])|\x60[^\x60]*\x60/gu, mask);
    if (/[「」『』“”"\x60]|(?<![\p{L}\p{N}])['‘’]/u.test(surface)) return null;

    // Split only at sequential connectors outside quotations, retaining the original question.
    const boundaries = surface.matchAll(/(?:[，,；;]\s*|(?<=[。！？?!])\s*|\s+|(?=\p{Script=Han}))(?:然后|接着|再|并且|并|and\s+then\b|then\b)\s*/giu);
    for (const boundary of boundaries) {
      const question = input.slice(0, boundary.index).trim();
      const leading = surface.slice(0, boundary.index).trim();
      const chineseReading = /^(?:(?:请|麻烦|帮我|能不能|可以|能否|先)\s*)*(?:解释|解读|分析|总结|概括|翻译|说明|告诉我|讲讲|说说|整理|对比|比较|梳理|回答|为什么|为何|如何|怎么)|(?:是什么意思|是什么|怎么理解)[？?。]?$/u;
      const englishReading = /^(?:(?:please|first)\s+|(?:can|could) you\s+)*(?:explain|summari[sz]e|analyse|analyze|interpret|translate|compare|tell me|what|why|how)\b/iu;
      if (!chineseReading.test(leading) && !englishReading.test(leading)) continue;
      if (/(?:如果|假如|假设|例如|比如|举例|演示|示范|不要|不用|先别|只(?:需要|要|用)|\b(?:if|suppose|pretend|for example|do not|don't)\b)/iu.test(leading)) continue;

      const actionOffset = boundary.index + boundary[0].length;
      const command = parseCommand(input.slice(actionOffset), true);
      if (!command) continue;
      if (!command.operations && command.kind !== 'answerHighlight') return null;
      const requiresAnswer = command.kind === 'answerHighlight' || command.operations?.some(operation =>
        operation.type === 'evidence' || operation.type === 'note' && !operation.text &&
          (!operation.target || operation.target === 'answer') || operation.target === 'citation');
      if (requiresAnswer && /(?:刚刚|刚才|上一[条轮]|\b(?:previous|last|you just)\b)/iu.test(surface.slice(actionOffset))) return null;
      return { kind: 'mixed', question, command };
    }
    return null;
  }

  function parse(input) {
    if (typeof input !== 'string' || input.length > 16000 || /[\uE000\uE001]/u.test(input)) return null;
    const draft = abstractSummary.exec(input.trim().replace(/[。？！?!]+$/u, '').trim());
    if (draft) {
      const quantity = draft[2];
      const count = quantity === '两' ? 2 : quantity && quantity !== '几' ? citationNumber(quantity) : 0;
      if (quantity && quantity !== '几' && !count) return { error: 'clarify' };
      const format = count ? '用 ' + count + ' 点' : quantity ? '用几点' : '';
      return {
        kind: 'mixed',
        question: '请仅根据这篇论文的摘要，' + format + '概括摘要内容。',
        command: { operations: [draft[1] ? {type: 'paperAbstract', commentFromAnswer: true} : {type: 'note'}] },
      };
    }
    return parseMixed(input) || parseCommand(input);
  }

  const api = { parse };
  root.AskGPTPaperCommandParser = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
