(function (root) {
  'use strict';
  const Core = root.AskGPTInlineCore ||
    (typeof require === 'function' ? require('./inline-core.js') : null);
  const Reading = root.AskGPTPaperReadingActions ||
    (typeof require === 'function' ? require('./paper-reading-actions.js') : null);
  const WIDTH = 4;
  const MAX_MATCHES = 128;
  const Stops = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'to', 'with', 'by', 'and', 'about',
    'related', 'concerning', 'finding', 'findings', 'result', 'results', 'evidence', 'content',
    '的', '和', '及', '与', '以及', '关于', '相关', '有关', '内容', '句子', '原句', '结果', '证据',
  ]);
  const Alternatives = new Set(['or', '或', '或者']);
  const normal = value => value.normalize('NFKC').replace(/\u00ad/g, '').toLowerCase();
  const words = new Intl.Segmenter(undefined, {granularity: 'word'});
  const sentences = new Intl.Segmenter(undefined, {granularity: 'sentence'});
  const parts = value => Array.from(words.segment(value), part => part.isWordLike ? part.segment : '')
    .filter(Boolean);

  function singular(term) {
    if (!/^[a-z]{3,}$/u.test(term)) return term;
    if (/[^aeiou]ies$/u.test(term)) return term.slice(0, -3) + 'y';
    if (/(?:ss|sh|ch|x|z)es$/u.test(term)) return term.slice(0, -2);
    if (/[^su]s$/u.test(term) && !term.endsWith('is')) return term.slice(0, -1);
    return term;
  }

  function compile(topic) {
    const alternatives = [[]];
    const all = parts(normal(topic));
    for (const term of all) {
      if (Alternatives.has(term)) alternatives.push([]);
      else if (!Stops.has(term)) alternatives.at(-1).push(singular(term));
    }
    const useful = alternatives.filter(group => group.length);
    return useful.length ? useful : all.length ? [all.map(singular)] : [];
  }

  function contains(text, queries, literalPhrases) {
    const clean = normal(text);
    if (literalPhrases.length) {
      const joinedHan = clean.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '');
      if (literalPhrases.some(phrase => joinedHan.includes(phrase))) return true;
    }
    const terms = new Set(parts(clean).map(singular));
    // The PDF can preserve a visible line-break hyphen in a split word.
    for (const match of clean.matchAll(/([\p{L}\p{M}]+)[-\u2010\u2011]([\p{L}\p{M}]+)/gu)) {
      terms.add(singular(match[1] + match[2]));
    }
    return queries.some(group => group.every(term => terms.has(term)));
  }

  function size(glyph) {
    const rect = glyph?.rect;
    return (rect?.length === 4 && Number.isFinite(rect[1]) && Number.isFinite(rect[3]))
      ? Math.abs(rect[3] - rect[1]) : 0;
  }

  // Keep native order and source offsets. A short larger line separated from
  // the following body text is its own block even if the PDF omitted markers.
  function blocks(chars) {
    const output = [];
    let start = 0, previous, lineHeight = 0, lineLength = 0, ending = '';
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      if (!char || char.ignorable || typeof char.c !== 'string' || !char.c.trim()) continue;
      const height = size(char);
      const span = Math.max(lineHeight, height);
      const gap = previous?.rect?.[1] - char.rect?.[1];
      const newLine = previous?.lineBreakAfter || previous?.paragraphBreakAfter
        || (span > 0 && Math.abs(gap) > span * .8);
      if (newLine) {
        const isolatedHeading = lineLength <= 72 && lineHeight > height * 1.16 && height > 0
          && gap > span && !/[.!?。！？;；]$/u.test(ending) && /^[\p{Lu}\p{Script=Han}]/u.test(char.c);
        if (previous.paragraphBreakAfter || (span > 0 && gap > span * 1.8) || isolatedHeading) {
          output.push({offset: start, chars: chars.slice(start, index)});
          start = index;
        }
        lineHeight = lineLength = 0;
      }
      lineHeight = Math.max(lineHeight, height);
      lineLength += char.c.length + Number(!!char.spaceAfter);
      ending = char.c.trim();
      previous = char;
    }
    if (start < chars.length) output.push({offset: start, chars: chars.slice(start)});
    return output;
  }

  const caption = /^(?:fig(?:ure)?s?\.?|tab(?:le)?s?\.?|图|表)\s*[A-Z]?\d+[A-Za-z]?(?:\s*[:.．：—–-]\s*|\s+|$)/iu;
  const sentenceEnd = /[.!?。！？]["'”’）)\]]*$/u;
  const tooMany = () => Object.assign(new Error('too-many-topic'), {code: 'too-many-topic', limit: MAX_MATCHES});

  function sentenceParts(text) {
    // Mask abbreviation periods for sentence splitting. Use the original
    // text at the resulting offsets, so the highlight never includes a guess.
    const masked = text
      .replace(/\b(?:figs?|eqs?|refs?|tabs?|nos?|vol|pp|p)\.(?=\s*\[?[A-Z]?\d)/giu, value => value.slice(0, -1) + '·')
      .replace(/\b(?:e\.g\.|i\.e\.)/giu, value => value.replace(/\./g, '·'));
    return Array.from(sentences.segment(masked), part => text.slice(part.index, part.index + part.segment.length).trim());
  }

  function pageMatches(chars, page, queries, literalPhrases) {
    const matches = [], unique = new Set();
    let unresolved = 0;
    for (const block of blocks(chars)) {
      for (const paragraph of Core.paragraphsFromChars(block.chars, {preserveVerticalGaps: true})) {
        if (!contains(paragraph, queries, literalPhrases)) continue;
        const text = paragraph.replace(caption, '');
        for (const quote of sentenceParts(text)) {
          if (!quote || !contains(quote, queries, literalPhrases)) continue;
          if (!sentenceEnd.test(quote) || quote.length > 6000) { unresolved++; continue; }
          const data = Reading.locateQuote(block.chars, quote);
          if (!data?.rects?.length) { unresolved++; continue; }
          const position = {pageIndex: page - 1, rects: data.rects};
          if (JSON.stringify(position).length > 6000) { unresolved++; continue; }
          const offset = block.offset + data.offset;
          if (unique.has(offset)) continue;
          unique.add(offset);
          matches.push({page, quote, offset, position});
          if (matches.length > MAX_MATCHES) throw tooMany();
        }
      }
    }
    return {matches, unresolved};
  }

  async function find({document, Components, setTimer, clearTimer, topic, translatedTopic, onProgress, pageCache}) {
    const pageCount = document.pdf.numPages;
    const input = [topic, ...(Array.isArray(translatedTopic) ? translatedTopic : [translatedTopic])]
      .filter(value => typeof value === 'string' && value.trim() && value.length <= 300).slice(0, 8);
    const queries = input.flatMap(compile);
    const literalPhrases = input.map(value => normal(value.trim()))
      .filter(value => /^[\p{Script=Han}]{2,}$/u.test(value));
    const matches = [], unreadPages = [];
    let unresolvedMatches = 0;
    for (let start = 0; queries.length && start < pageCount; start += WIDTH) {
      document.current();
      const count = Math.min(WIDTH, pageCount - start);
      const read = Array.from({length: count}, async (_, offset) => {
        const index = start + offset;
        const chars = await (pageCache?.get(index) ?? Reading.pageChars({
          ...document, index, Components, setTimer, clearTimer,
        }));
        document.current();
        if (!Array.isArray(chars) || !chars.length || chars.length > 100000
            || !chars.some(char => !char?.ignorable && typeof char?.c === 'string' && char.c.trim())) return null;
        try { return pageMatches(chars, index + 1, queries, literalPhrases); }
        catch (error) {
          if (error?.code === 'too-many-topic') throw error;
          return null;
        }
      });
      (await Promise.all(read)).forEach((output, index) => {
        if (!output) { unreadPages.push(start + index + 1); return; }
        matches.push(...output.matches);
        unresolvedMatches += output.unresolved;
      });
      onProgress?.(start + count, pageCount);
      if (matches.length > MAX_MATCHES) throw tooMany();
    }
    document.current();
    return {matches, pagesScanned: queries.length ? pageCount - unreadPages.length : 0, pageCount, unreadPages, unresolvedMatches};
  }

  const api = {find};
  root.AskGPTPaperTopic = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
