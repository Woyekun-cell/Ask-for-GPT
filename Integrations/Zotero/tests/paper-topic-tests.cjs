const test = require('node:test');
const assert = require('node:assert/strict');
const {find} = require('../content/paper-topic.js');

function line(text, y, height = 12, paragraphBreakAfter = false) {
  const glyphs = Array.from(text, (c, i) => ({
    c, rect: [15 + 6 * i, y, 20 + 6 * i, y + height],
  }));
  const end = glyphs.at(-1);
  end.lineBreakAfter = true;
  end.paragraphBreakAfter = paragraphBreakAfter;
  return glyphs;
}

function fromPages(pages) {
  return {
    view: {_pdfPages: pages.map(chars => ({chars}))},
    pdf: {numPages: pages.length}, current() {},
  };
}

test('finds whole native sentences across the PDF without including a heading or abbreviation fragment', async () => {
  const heading = line('Second result', 633.895, 13.875);
  const first = 'The validation stage used thirty trials (Fig. 2) and reached 91.4 percent.';
  const second = 'A blinded validation cohort reproduced the result.';
  const pages = [
    [...heading, ...line(first + ' Calibration ran again.', 609.516, 11.1)],
    line('Figure S2. ' + second + ' Sample sizes were fixed.', 600),
    [],
  ];
  const updates = [];
  const found = await find({document: fromPages(pages), topic: 'validation',
    onProgress: (...progress) => updates.push(progress)});
  assert.deepEqual(found, {
    matches: [
      {page: 1, quote: first, offset: heading.length, position: {
        pageIndex: 0, rects: [[15, 609.516, 20 + 6 * (first.length - 1), 609.516 + 11.1]],
      }},
      {page: 2, quote: second, offset: 'Figure S2. '.length, position: {
        pageIndex: 1, rects: [[15 + 6 * 'Figure S2. '.length, 600,
          20 + 6 * ('Figure S2. '.length + second.length - 1), 612]],
      }},
    ],
    pagesScanned: 2, pageCount: 3, unreadPages: [3], unresolvedMatches: 0,
  });
  assert.deepEqual(updates, [[3, 3]]);
});

test('requires distinct topic terms within a single sentence and uses optional translated terminology', async () => {
  const first = 'Smoking frequency increased. Somatic deletion counts rose.';
  const second = 'In smokers, prior smoking exposure correlated with somatic deletions.';
  const third = '在本组中，吸烟和缺失存在相关性。';
  const result = await find({document: fromPages([line(first, 602), [...line(second, 620), ...line(third, 590)]]),
    topic: '吸烟和缺失', translatedTopic: 'smoking and deletion'});
  assert.deepEqual(result.matches.map(({page, quote}) => [page, quote]), [[2, second], [2, third]]);
  assert.equal(result.unresolvedMatches, 0);
});

test('resolves real hyphenated wraps in a sentence and skips ambiguous or incomplete text', async () => {
  const wrapped = 'The valida-tion passed after a repeat experiment.';
  const repeated = 'The validation used identical controls.';
  const pages = [
    [...line('The valida-', 620), ...line('tion passed after a repeat experiment.', 607),
      ...line('Validation controls overview', 570)],
    line(repeated + ' ' + repeated, 620),
    [...line(repeated, 620, 12, true), ...line(repeated, 600)],
  ];
  const result = await find({document: fromPages(pages), topic: 'validation'});
  assert.deepEqual(result.matches.map(({page, quote, position}) => [page, quote, position.rects.length]),
    [[1, wrapped, 2], [3, repeated, 1], [3, repeated, 1]]);
  assert.equal(result.unresolvedMatches, 3);
  assert.notEqual(result.matches[1].offset, result.matches[2].offset);
});

test('reports too many matches instead of silently taking a prefix', async () => {
  const pages = Array.from({length: 129}, (_, index) => line('Validation check included sample ' + (index + 1) + '.', 600));
  await assert.rejects(find({document: fromPages(pages), topic: 'validation'}), {code: 'too-many-topic', limit: 128});
});

test('uses cached and lazily loaded native pages and rejects work after a tab switch', async () => {
  const document = fromPages([[], []]);
  let loads = 0, stale = false;
  document.current = () => {
    if (stale) throw Object.assign(new Error('stale'), {code: 'stale'});
  };
  document.pdf.getPageData = async ({pageIndex}) => {
    assert.equal(pageIndex, 1);
    loads++;
    return {chars: line('A second validation uses a fixed sample size.', 602)};
  };
  const pageCache = new Map([[0, Promise.resolve(line('The validation succeeded.', 600))]]);
  const params = {document, pageCache, topic: 'validation'};
  const first = await find(params);
  assert.equal(first.matches.length, 2);
  assert.equal(loads, 1);
  await assert.rejects(find({...params, onProgress: () => { stale = true; }}), {code: 'stale'});
});
