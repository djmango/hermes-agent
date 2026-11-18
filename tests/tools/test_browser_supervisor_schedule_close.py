"""The supervisor's cross-thread schedule helper must never orphan a coroutine.

``CDPSupervisor.stop()`` hands ``self._close_ws()`` to the supervisor loop through
``_schedule`` so the WebSocket is closed from inside the loop (``async for raw in
self._ws`` returns cleanly, ``_run`` hits its ``finally``). When the loop has already
stopped — a concurrent ``stop()``, or the supervisor thread exiting on its own — the
coroutine is never awaited: the journal fills with ``RuntimeWarning: coroutine
'CDPSupervisor._close_ws' was never awaited`` and the socket is left to process
teardown instead of being closed.

These tests pin both directions on the helper itself, with no browser and no loop of
their own beyond a plain thread running a real event loop.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import gc
import inspect
import threading
import warnings

import pytest

from tools import browser_supervisor as bs


async def _noop() -> str:
    return "closed"


def _capture_never_completing(monkeypatch) -> dict:
    """Make ``_schedule`` see a loop that accepted the coroutine but never ran it.

    Returns a dict that receives the coroutine under ``"coro"`` so the caller can read
    its final state. Mirrors the wedged/stopped-loop case, where the scheduling call
    itself succeeds and raises nothing.
    """
    seen: dict = {}
    fut: concurrent.futures.Future = concurrent.futures.Future()

    def _fake(coro, loop, **_kwargs):
        seen["coro"] = coro
        return fut  # accepted, never resolved: the callback never fires

    monkeypatch.setattr("agent.async_utils.safe_schedule_threadsafe", _fake)
    return seen


def test_schedule_closes_a_coroutine_the_loop_never_started(monkeypatch):
    seen = _capture_never_completing(monkeypatch)
    with pytest.raises(concurrent.futures.TimeoutError):
        bs._schedule(_noop(), object(), timeout=0.02)

    coro = seen.pop("coro")  # take the only remaining reference
    assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        del coro
        gc.collect()
    assert not [w for w in caught if "never awaited" in str(w.message)]


def test_schedule_leaves_a_started_coroutine_to_the_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        coro = _noop()
        assert bs._schedule(coro, loop, timeout=2.0) == "closed"
        assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2.0)
        loop.close()


def test_schedule_reports_an_unavailable_loop():
    with pytest.raises(bs._LoopUnavailable):
        bs._schedule(_noop(), None, timeout=0.02)


def test_stop_closes_the_websocket_coroutine_when_the_loop_never_runs_it(monkeypatch):
    """The reported line: ``stop()`` -> ``_schedule(self._close_ws(), loop, ...)``."""
    seen = _capture_never_completing(monkeypatch)

    class _RunningLoop:
        def is_running(self) -> bool:
            return True

    supervisor = bs.CDPSupervisor.__new__(bs.CDPSupervisor)
    supervisor._loop = _RunningLoop()
    supervisor._thread = None
    supervisor._active = True
    supervisor._stop_requested = False
    supervisor._state_lock = threading.Lock()

    supervisor.stop(timeout=0.02)

    assert supervisor._stop_requested is True
    assert supervisor._active is False
    # Without the helper closing it, this is CORO_CREATED and Python warns on GC.
    assert inspect.getcoroutinestate(seen["coro"]) == inspect.CORO_CLOSED
