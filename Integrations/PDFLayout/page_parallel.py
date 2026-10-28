"""Bounded independent page model I/O; PDF layout stages stay unchanged."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
import queue
import threading
import time

from layout_common import ProtocolFailure
from batch_permits import BatchPermits

MAX_PAGE_WORKERS = 4


class NativeHelperPool:
    """Each slot owns an unchanged JSONL helper and its isolated CLI session."""
    def __init__(self,factory,workers=MAX_PAGE_WORKERS,*,global_permit_directory=None):
        if type(workers) is not int or not 1<=workers<=MAX_PAGE_WORKERS: raise ValueError("invalid_page_workers")
        self.factory,self.workers=factory,workers
        self.lock=threading.Lock();self.available=queue.Queue();self.contexts=[];self.closed=False
        self.cancelled=threading.Event()
        self.permits=BatchPermits(global_permit_directory) if global_permit_directory is not None else None

    def __enter__(self):
        try:
            for _ in range(self.workers):
                context=self.factory();helper=context.__enter__()
                self.contexts.append(context)
                bind=getattr(helper,"bind_batch_cancellation",None)
                if callable(bind):bind(self.cancelled)
                self.available.put(helper)
        except BaseException:
            self.close();raise
        return self

    @contextmanager
    def lease(self):
        """Borrow one isolated helper for exactly one bounded model turn."""
        while True:
            with self.lock:
                if self.closed:raise ProtocolFailure("gpt_unavailable")
            try:helper=self.available.get(timeout=.05);break
            except queue.Empty:continue
        try:
            with self.permits.hold(self.cancelled) if self.permits else nullcontext():
                with self.lock:
                    if self.closed:raise ProtocolFailure("gpt_unavailable")
                yield helper
        finally:
            with self.lock:
                if not self.closed:self.available.put(helper)

    def translate_batch(self,segments,context=None):
        with self.lease() as helper:
            return (helper.translate_batch(segments,context=context) if context is not None
                    else helper.translate_batch(segments))

    def cancel(self):self.close()

    def close(self):
        with self.lock:
            if self.closed:return
            self.closed=True;self.cancelled.set();contexts=self.contexts[:]
        for context in contexts:
            try:
                cancel=getattr(context,"cancel",None)
                if callable(cancel):cancel()
            except Exception:pass
            try:context.__exit__(None,None,None)
            except Exception:pass  # Continue retiring every helper in this job.

    def __exit__(self,*args):self.close()


@contextmanager
def parallel_page_translation(high_level,workers=MAX_PAGE_WORKERS):
    """Parallelize only the pinned Python-IR page batch adapter.

    Detection, PDF extraction, fonts, typesetting and PDF writing retain their
    original process/main-thread scheduling. The adapter's preprocessing and
    application touch only each page's separate Python IR objects. Its rich
    text/font-mapping path is disabled by the existing worker configuration.
    """
    if type(workers) is not int or not 1<=workers<=MAX_PAGE_WORKERS:raise ValueError("invalid_page_workers")
    original=high_level.ILTranslator
    if workers==1:
        yield
        return

    class ParallelPageTranslator(original):
        def translate(self,document):
            self._page_pool=ThreadPoolExecutor(max_workers=workers,thread_name_prefix="askgpt-page")
            self._page_slots=threading.BoundedSemaphore(workers)
            self._page_lock=threading.Lock();self._page_failure=None;self._page_futures=[]
            self._last_page=document.page[-1] if document.page else None
            try:
                result=super().translate(document)
                for future in self._page_futures:future.result()
                self._raise_page_failure()
                return result
            except BaseException as error:
                self._fail_page(error)
                self._raise_page_failure()
                raise
            finally:
                self._page_pool.shutdown(wait=True,cancel_futures=True)

        def _raise_page_failure(self):
            with self._page_lock:error=self._page_failure
            if error is not None:raise error

        def _fail_page(self,error):
            with self._page_lock:
                first=self._page_failure is None
                if first:self._page_failure=error
            if first:
                abort=getattr(self.translate_engine,"abort_page_batches",None)
                if callable(abort):
                    try:abort()
                    except Exception:pass

        def process_page(self,page,executor,pbar=None,tracker=None):
            if not hasattr(self,"_page_pool"):
                return super().process_page(page,executor,pbar,tracker)
            # Keeping only `workers` futures in flight also bounds queued model
            # work. The upstream paragraph executor remains configured as one.
            while not self._page_slots.acquire(timeout=.05):
                self._raise_page_failure();self.translation_config.raise_if_cancelled()
            try:
                self._raise_page_failure();self.translation_config.raise_if_cancelled()
                future=self._page_pool.submit(self._run_page,page,pbar,tracker)
                self._page_futures.append(future)
                future.add_done_callback(lambda _:self._page_slots.release())
            except BaseException:
                self._page_slots.release();raise
            # The base method closes its progress stage and serializes tracking
            # immediately after this loop. Keep its final call open until every
            # validated page has actually been applied, before typesetting too.
            if page is self._last_page:
                for future in self._page_futures:future.result()
                self._raise_page_failure()

        def _run_page(self,page,pbar,tracker):
            started=time.monotonic()
            try:
                self._raise_page_failure()
                return super().process_page(page,None,pbar,tracker)
            except BaseException as error:
                self._fail_page(error);raise
            finally:
                record=getattr(self.translate_engine,"page_timing",None)
                if callable(record):
                    try:record(getattr(page,"page_number",None),time.monotonic()-started)
                    except Exception:pass

    high_level.ILTranslator=ParallelPageTranslator
    try:yield
    finally:high_level.ILTranslator=original
