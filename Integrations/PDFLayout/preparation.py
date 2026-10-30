"""Job-local scheduling changes; PDF instructions and model inputs stay exact."""
from contextlib import contextmanager


@contextmanager
def compact_graphic_history():
    from babeldoc.format.pdf.document_il.frontend import il_creater_active_support as support
    from babeldoc.format.pdf.document_il.frontend import il_creater_active as active
    original, imported = support.replace_first_passthrough_operator, active.replace_first_passthrough_operator
    def replace(snapshot, operator, instruction):
        # Snapshots are persistent: retain every live node in its original order,
        # but stop each later glyph from walking thousands of overwritten states.
        if (isinstance(snapshot, support.PassthroughSnapshot)
                and snapshot.event_count > 256 and snapshot.next_version % 128 == 0):
            latest = dict(snapshot.latest_versions)
            kept, node = [], snapshot.tail
            while node is not None:
                if node.replace_key is None or latest.get(node.replace_key) == node.version:
                    kept.append(node)
                node = node.parent
            tail = None
            for node in reversed(kept):
                tail = support._PassthroughNode(tail, node.instruction, node.replace_key,
                                               node.version, 1 if tail is None else tail.length + 1)
            snapshot = support.PassthroughSnapshot(tail, snapshot.latest_versions, snapshot.next_version)
        return original(snapshot, operator, instruction)

    support.replace_first_passthrough_operator = active.replace_first_passthrough_operator = replace
    try:
        yield
    finally:
        support.replace_first_passthrough_operator, active.replace_first_passthrough_operator = original, imported
