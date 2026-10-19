"""A worker that refused the model pin must say so on the card, not only in its log.

The reclaim path used to record "pid N exited with code 1" for any nonzero
worker exit, which is exactly the silence the pin exists to end.
"""

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_dispatch as dispatch


def _write_log(task_id: str, text: str) -> None:
    log_dir = kb.worker_logs_dir(None)
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / f"{task_id}.log").write_text(text, encoding="utf-8")


def test_pin_refusal_sentence_is_read_out_of_the_worker_log():
    _write_log(
        "t_pin_refused",
        "Initializing agent...\n"
        "MODEL PIN REFUSED: pinned model anthropic/claude-opus-5-5 could not be served "
        "(rate limit). Refusing to continue on another model: the pin is the point of this run.\n"
        "Traceback (most recent call last):\n",
    )
    text = dispatch._worker_log_pin_refusal("t_pin_refused")
    assert text.startswith("MODEL PIN REFUSED:")
    assert "claude-opus-5-5" in text
    assert "Traceback" not in text


def test_a_log_without_a_pin_refusal_reads_empty():
    _write_log("t_plain_crash", "Traceback (most recent call last):\nRuntimeError: boom\n")
    assert dispatch._worker_log_pin_refusal("t_plain_crash") == ""


def test_a_missing_log_reads_empty():
    assert dispatch._worker_log_pin_refusal("t_no_such_worker_log") == ""