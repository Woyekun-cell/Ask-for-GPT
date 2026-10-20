/** Shared, raw-text host contract. Offsets are UTF-16 code units, never model offsets. */
export class HostContractError extends Error {
  constructor(code, message = code) { super(message); this.name = 'HostContractError'; this.code = code; }
}
export const SCOPES = Object.freeze(['selection', 'visiblePages', 'activeParagraph', 'cursorPage']);
export class WritingHostAdapter {
  async initialize() { throw new HostContractError('notImplemented'); }
  async captureScope(_mode) { throw new HostContractError('notImplemented'); }
  async watch(_onChange) { throw new HostContractError('notImplemented'); }
  async focusIssue(_envelope) { throw new HostContractError('notImplemented'); }
  async applyIssue(_envelope) { throw new HostContractError('notImplemented'); }
  async clear() {}
  async dispose() { await this.clear(); }
}
export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export function assertUTF16Range(text, range) {
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < 0 || range.length < 0 || range.start + range.length > text.length) throw new HostContractError('invalidRange', 'Invalid UTF-16 range');
  for (const offset of [range.start, range.start + range.length]) {
    if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) throw new HostContractError('invalidRange', 'UTF-16 boundary splits a surrogate pair');
  }
  if (globalThis.Intl?.Segmenter) {
    const boundaries = new Set([0, text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index)]);
    if (!boundaries.has(range.start) || !boundaries.has(range.start + range.length)) throw new HostContractError('invalidRange', 'UTF-16 boundary splits a grapheme');
  }
  return range;
}
export async function createSnapshot(fields) {
  if (typeof fields.rawText !== 'string' || !SCOPES.includes(fields.scope)) throw new HostContractError('invalidSnapshot');
  assertUTF16Range(fields.rawText, fields.targetRange);
  if (fields.targetRange.length > 4000 || fields.contextBefore.length + fields.contextAfter.length > 2000 || fields.rawText.length + fields.contextBefore.length + fields.contextAfter.length > 6000) throw new HostContractError('scopeTooLarge', '请缩小检查范围：目标最多 4000 UTF-16，上下文合计最多 2000。');
  return { ...fields, revision: String(fields.revision), snapshotHash: await sha256(fields.rawText), contextHash: await sha256(fields.contextBefore + '\u0000' + fields.contextAfter) };
}
export function assertIssueEnvelope(envelope) {
  const { snapshot, issue } = envelope || {};
  if (!snapshot || !issue || typeof snapshot.rawText !== 'string' || typeof issue.original !== 'string' || typeof issue.replacement !== 'string') throw new HostContractError('invalidEnvelope');
  assertUTF16Range(snapshot.rawText, issue.range);
  const { start, length } = issue.range;
  if (!length || snapshot.rawText.slice(start, start + length) !== issue.original) throw new HostContractError('originalMismatch', 'Issue range differs from original');
  if (start < snapshot.targetRange.start || start + length > snapshot.targetRange.start + snapshot.targetRange.length) throw new HostContractError('outsideTarget');
  return envelope;
}
export function overlaps(a, b) { return a.start < b.start + b.length && b.start < a.start + a.length; }
