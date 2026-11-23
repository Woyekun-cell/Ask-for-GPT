"""Allow only static PaperLens content in an untrusted model HTML fragment."""
import re
import unicodedata
from collections import Counter, defaultdict
from html import escape
from html.parser import HTMLParser


TAGS = frozenset('''
    header section article footer aside nav div span p h1 h2 h3 h4 h5 h6
    ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td
    details summary figure figcaption a button q blockquote cite abbr
    strong em b i u s small mark code pre kbd samp var sub sup time br hr wbr
'''.split())
VOID_TAGS = frozenset(('br', 'hr', 'col', 'wbr'))
GLOBAL_ATTRS = frozenset(('id', 'class', 'lang', 'dir', 'title', 'role', 'hidden'))
PROTOTYPE_NAMES = frozenset(('__proto__', 'constructor', 'prototype'))
TEMPLATE_IDS = frozenset(('reader', 'reader-nav', 'mast-current', 'figure-viewer', 'viewer-title'))
IDENTIFIER = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,95}')
CUSTOM_ATTR = re.compile(r'(?:data|aria)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)')
TABLE_SPAN = re.compile(r'[1-9][0-9]{0,2}')
FIGURE_LABEL = r'(?:图|fig(?:ure|\.)?)\s*[0-9]+[a-z]?'
NAV_FIGURE_PREFIX = re.compile(
    rf'^\s*(?:{FIGURE_LABEL}(?:\s*[|｜:：、·–—]\s*|\s+-\s+|\.\s+))+(?P<title>\S.*)$', re.I,
)
LOCATOR_LINE = r'''[^<]*(?:<span class="quote-source">[^<]*</span>\s*)?'''
LOCATOR_LANGUAGE_PAIR = re.compile(
    r'''(\s*<span\s+class\s*=\s*["']language-pair["']\s*>\s*'''
    r'''<span\s+lang\s*=\s*["']zh(?:-[a-z0-9]+)*["']\s*>)''' + LOCATOR_LINE +
    r'''(</span\s*>\s*<span\s+lang\s*=\s*["']en(?:-[a-z0-9]+)*["']\s*>)''' + LOCATOR_LINE +
    r'''(</span\s*>\s*</span\s*>\s*)''', re.I,
)


class _FragmentParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []
        self.ids = set()
        self.started = False

    def handle_starttag(self, tag, attrs):
        if tag not in TAGS:
            raise ValueError('Unsupported fragment element')
        attributes = dict(attrs)
        if len(attributes) != len(attrs):
            raise ValueError('Duplicate fragment attribute')
        if tag == 'button' and attributes.get('type') != 'button':
            raise ValueError('A fragment button needs type="button"')
        for name, value in attrs:
            self.check_attribute(tag, name, value)
        self.started = True
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def check_attribute(self, tag, name, value):
        if value is None and name not in {'hidden', 'open'}:
            raise ValueError('A fragment attribute is missing its value')
        if value is not None and any(char in '<>' or unicodedata.category(char) in {'Cc', 'Cf', 'Cs'} for char in value):
            raise ValueError('Unsafe fragment attribute value')
        if name == 'id':
            if not IDENTIFIER.fullmatch(value) or value.lower() in TEMPLATE_IDS | PROTOTYPE_NAMES or value in self.ids:
                raise ValueError('Unsafe or duplicate fragment ID')
            self.ids.add(value)
        if name in GLOBAL_ATTRS or tag == 'details' and name == 'open' or tag == 'button' and name == 'type':
            return
        if name == 'href' and tag == 'a' and value.startswith('#') and IDENTIFIER.fullmatch(value[1:]):
            return
        if name in {'rowspan', 'colspan'} and tag in {'th', 'td'} and TABLE_SPAN.fullmatch(value):
            return
        custom = CUSTOM_ATTR.fullmatch(name)
        if custom and custom[1] not in PROTOTYPE_NAMES and name not in {'data-full-src', 'data-ve-kit'}:
            return
        raise ValueError('Unsupported fragment attribute')

    def handle_startendtag(self, tag, attrs):
        if tag not in VOID_TAGS:
            raise ValueError('Only void elements can be self-closing in a fragment')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            raise ValueError('Fragment elements must be explicitly balanced')

    def handle_data(self, data):
        if '<' in data or any(char not in '\t\r\n' and unicodedata.category(char) in {'Cc', 'Cs'} for char in data):
            raise ValueError('Malformed fragment text')

    def reject_markup(self, _):
        raise ValueError('Fragment declarations, instructions and comments are unsupported')

    handle_decl = handle_comment = handle_pi = unknown_decl = reject_markup


class _SourceParser(_FragmentParser):
    def __init__(self, fragment):
        super().__init__()
        self.fragment = fragment
        self.line_starts = [0] + [match.end() for match in re.finditer('\n', fragment)]

    def source_offset(self):
        line, column = self.getpos()
        return self.line_starts[line - 1] + column


class _LocatorParser(_SourceParser):
    def __init__(self, fragment):
        super().__init__(fragment)
        self.anchors = []
        self.anchor_counts = Counter()
        self.open_locators = []
        self.locators = defaultdict(list)

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        attributes = dict(attrs)
        evidence = attributes.get('data-evidence')
        locator = 'quote-locator' in attributes.get('class', '').split()
        if evidence:
            self.anchor_counts[evidence] += 1
        if tag in VOID_TAGS:
            if locator and self.anchors:
                self.locators[self.anchors[-1][1]].append(None)
            return
        depth = len(self.stack)
        if evidence:
            self.anchors.append((depth, evidence))
        if locator and self.anchors:
            start = None
            if len(self.anchors) == 1 and 'q' not in self.stack and 'button' not in self.stack:
                start = self.source_offset() + len(self.get_starttag_text())
            self.open_locators.append((depth, self.anchors[-1][1], start))

    def handle_endtag(self, tag):
        depth = len(self.stack)
        super().handle_endtag(tag)
        if self.open_locators and self.open_locators[-1][0] == depth:
            _, evidence, start = self.open_locators.pop()
            self.locators[evidence].append(None if start is None else (start, self.source_offset()))
        if self.anchors and self.anchors[-1][0] == depth:
            self.anchors.pop()


class _ReaderLayoutParser(_SourceParser):
    def __init__(self, fragment):
        super().__init__(fragment)
        self.heading_children = None
        self.top_classes = set()
        self.replacements = []

    def handle_starttag(self, tag, attrs):
        depth = len(self.stack)
        super().handle_starttag(tag, attrs)
        attributes = dict(attrs)
        classes = attributes.get('class', '').split()
        if depth == 0:
            self.top_classes = set(classes)
            if tag == 'header' and 'paper-heading' in classes:
                self.heading_children = []
        elif depth == 1 and self.heading_children is not None:
            start = self.source_offset()
            self.heading_children.append({
                'tag': tag, 'classes': set(classes), 'start': start,
                'end': start + len(self.get_starttag_text()),
            })
        removed = set()
        if depth == 0 and 'hero' in classes:
            removed.add('key-points')
        if 'chapter' in self.top_classes and 'aside' not in self.stack and (depth == 0 or tag == 'p'):
            removed.add('interpretation')
        updated = attributes.copy()
        if removed.intersection(classes):
            remaining = ' '.join(token for token in classes if token not in removed)
            if remaining:
                updated['class'] = remaining
            else:
                del updated['class']
        if depth == 0 and tag in {'header', 'section', 'article'} and 'id' in attributes:
            for name in ('data-nav', 'data-nav-en'):
                value = attributes.get(name, '')
                match = NAV_FIGURE_PREFIX.fullmatch(value)
                if match:
                    title = match['title'].strip()
                    if re.search(r'[^\W\d_]', title) and not re.fullmatch(FIGURE_LABEL, title, re.I):
                        updated[name] = title
        if updated == attributes:
            return
        serialized = ''.join(
            f' {name}' if value is None else f' {name}="{escape(value)}"' for name, value in updated.items()
        )
        start = self.source_offset()
        self.replacements.append((start, start + len(self.get_starttag_text()), f'<{tag}{serialized}>'))

    def handle_endtag(self, tag):
        depth = len(self.stack)
        super().handle_endtag(tag)
        if self.heading_children is None:
            return
        if depth == 2:
            end = self.fragment.index('>', self.source_offset()) + 1
            self.heading_children[-1]['end'] = end
        elif depth == 1:
            self.wrap_heading_copy()
            self.heading_children = None

    def wrap_heading_copy(self):
        children = self.heading_children
        if any('hero-copy' in child['classes'] for child in children):
            return
        if not any(child['tag'] == 'figure' and 'paper-front' in child['classes'] for child in children):
            return
        if sum(child['tag'] == 'h1' for child in children) != 1:
            return
        copies = [index for index, child in enumerate(children)
                  if child['tag'] == 'h1' or child['tag'] in {'p', 'div'}
                  and child['classes'].intersection({'byline', 'paper-byline', 'paper-meta'})]
        first, last = copies[0], copies[-1]
        if len(copies) != last - first + 1:
            return
        for previous, following in zip(children[first:last], children[first + 1:last + 1]):
            if self.fragment[previous['end']:following['start']].strip():
                return
        start, end = children[first]['start'], children[last]['end']
        self.replacements.extend(((start, start, '<div class="hero-copy">'), (end, end, '</div>')))


def _parse_fragment(fragment, parser):
    if not isinstance(fragment, str):
        raise ValueError('Expected a reader HTML fragment')
    parser.feed(fragment)
    if '<' in parser.rawdata:
        raise ValueError('Incomplete fragment markup')
    parser.close()
    if parser.stack or not parser.started:
        raise ValueError('Expected balanced reader HTML elements')


def validate_fragment(fragment: str) -> None:
    """Raise ValueError for markup that cannot be embedded as static reader content."""
    _parse_fragment(fragment, _FragmentParser())


def _replace_spans(fragment, replacements):
    if not replacements:
        return fragment
    parts, previous = [], 0
    for start, end, replacement in sorted(replacements):
        parts.extend((fragment[previous:start], replacement))
        previous = end
    parts.append(fragment[previous:])
    return ''.join(parts)


def normalize_reader_layout(fragment: str) -> str:
    """Keep the paper opening, overview and chapter styling in their intended containers."""
    if not isinstance(fragment, str):
        raise ValueError('Expected a reader HTML fragment')
    parser = _ReaderLayoutParser(fragment)
    _parse_fragment(fragment, parser)
    return _replace_spans(fragment, parser.replacements)


def render_evidence_locators(fragment: str, evidence: list[dict]) -> str:
    """Replace the text of unambiguous evidence locators with their manifest labels."""
    if not isinstance(fragment, str):
        raise ValueError('Expected a reader HTML fragment')
    parser = _LocatorParser(fragment)
    _parse_fragment(fragment, parser)
    replacements = []
    for item in evidence:
        identity = item['id']
        spans = parser.locators.get(identity, ())
        if parser.anchor_counts[identity] != 1 or len(spans) != 1 or spans[0] is None:
            continue
        start, end = spans[0]
        original = fragment[start:end]
        # Source descriptions stay in the same locator so both evidence verifiers
        # can inspect them, while the reader shows them on their own line.
        labels = escape(' · '.join(item[key] for key in ('section', 'figure', 'supplement') if item.get(key)), quote=False)
        parser.handle_data(labels)
        source = f' <span class="quote-source">{labels}</span>' if labels else ''
        chinese, english = [], []
        if item.get('printPage') is not None:
            chinese.append(f"印刷页 {item['printPage']}")
            english.append(f"Print p. {item['printPage']}")
        chinese.append(f"PDF 第 {item['pdfPage']} 页")
        english.append(f"PDF p. {item['pdfPage']}")
        english = escape(' · '.join(english), quote=False)
        parser.handle_data(english)
        pair = LOCATOR_LANGUAGE_PAIR.fullmatch(original)
        if pair:
            chinese = escape(' · '.join(chinese), quote=False)
            parser.handle_data(chinese)
            opening, separator, closing = pair.groups()
            replacement = opening + chinese + source + separator + english + source + closing
        elif re.fullmatch(LOCATOR_LINE, original):
            replacement = english + source
        else:
            # Leave nested markup with its own identity or controls intact.
            continue
        replacements.append((start, end, replacement))
    return _replace_spans(fragment, replacements)
