"""Model pins: an explicitly named model is an identity, not a preference.

A card, a slash command or an operator that names a model (``-m/--model``,
``--provider``) pins it. A provider fallback may change the ROUTE to that
model; it must never change the model. When no allowed route serves the pinned
model the run refuses with the pin named, instead of quietly continuing on a
different (usually weaker) model.

Silence was the bug: a kanban card pinned to ``claude-opus-5-5`` ran on
``deepseek-v4.1-flash`` because the primary route was rate limited and the
fallback chain happily swapped the model. Nothing said so until the worker
noticed it by reading its own system prompt.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)


class ModelPinRefusedError(RuntimeError):
    """The pinned model cannot be served on any allowed route.

    Raised instead of continuing on a different model. ``refused`` names every
    route that was considered and why it was not usable.
    """

    def __init__(
        self,
        message: str,
        *,
        pinned_model: str = "",
        pinned_provider: str = "",
        refused: Optional[Iterable[tuple[str, str]]] = None,
    ) -> None:
        super().__init__(message)
        self.pinned_model = pinned_model
        self.pinned_provider = pinned_provider
        self.refused = list(refused or ())


def model_identity(model: Any) -> str:
    """Provider-independent identity of a model id.

    Folds the two spellings the same model travels under: an aggregator vendor
    prefix (``anthropic/``) and dot notation (``claude-opus-5.5``) both reduce
    to ``claude-opus-5-5``. Two ids that fold equal are the same model served
    by a different route; anything else is a different model.
    """
    text = str(model or "").strip().lower()
    if "/" in text:
        text = text.rsplit("/", 1)[-1]
    text = text.replace(".", "-")
    return re.sub(r"\s+", "", text)


def agent_pin(agent: Any) -> Optional[dict[str, str]]:
    """The ``{"provider", "model"}`` pin carried by *agent*, or None."""
    pin = getattr(agent, "_model_pin", None)
    if not isinstance(pin, dict):
        return None
    model = str(pin.get("model") or "").strip()
    if not model:
        return None
    return {"provider": str(pin.get("provider") or "").strip().lower(), "model": model}


def set_pin(agent: Any, provider: str, model: str) -> None:
    """Record an explicit model choice as the pin."""
    if not str(model or "").strip():
        agent._model_pin = None
        return
    agent._model_pin = {"provider": str(provider or "").strip().lower(), "model": str(model).strip()}


def pin_refuses(agent: Any, provider: str, model: str) -> bool:
    """True when *model* on *provider* is a DIFFERENT model than the pin.

    Same identity on another provider is allowed: that is a route change, and
    it is how a pinned model survives one account's quota.
    """
    pin = agent_pin(agent)
    if pin is None:
        return False
    return model_identity(model) != model_identity(pin["model"])


def record_pin_refusal(agent: Any, provider: str, why: str) -> None:
    """Note that a fallback route was skipped because it serves another model."""
    refusals = getattr(agent, "_model_pin_refusals", None)
    if not isinstance(refusals, list):
        refusals = []
        agent._model_pin_refusals = refusals
    entry = (str(provider or ""), str(why or ""))
    if entry not in refusals:
        refusals.append(entry)
    logger.debug("Pin refused fallback route %s: %s", provider, why)


def pin_refusal_error(agent: Any, reason: str) -> Optional[ModelPinRefusedError]:
    """The error to raise when a pinned run has run out of routes, else None.

    Built here so every caller (init-time client build, runtime chain exhaustion) refuses with
    the same words. The run must not continue on another model: the pin is the point of it.
    """
    pin = agent_pin(agent)
    if pin is None:
        return None
    refusals = getattr(agent, "_model_pin_refusals", None) or []
    return ModelPinRefusedError(
        refusal_message(
            agent,
            str(reason or "the provider did not serve it"),
            refusals,
            current_provider=str(getattr(agent, "provider", "") or ""),
            current_model=str(getattr(agent, "model", "") or ""),
        ),
        pinned_model=pin["model"],
        pinned_provider=pin["provider"],
        refused=refusals,
    )


def refusal_message(
    agent: Any,
    reason: str,
    refused: Iterable[tuple[str, str]] = (),
    *,
    current_provider: str = "",
    current_model: str = "",
) -> str:
    """One operator-readable line naming the pin and what refused to serve it."""
    pin = agent_pin(agent) or {"provider": "", "model": ""}
    route = f"{pin['provider']}/{pin['model']}" if pin["provider"] else pin["model"]
    lines = [
        f"MODEL PIN REFUSED: pinned model {route} could not be served ({reason}).",
        "Refusing to continue on another model: the pin is the point of this run.",
    ]
    tried = "; ".join(f"{p} ({why})" for p, why in refused)
    if tried:
        lines.append(f"Routes refused: {tried}.")
    if current_model and model_identity(current_model) != model_identity(pin["model"]):
        via = f" via {current_provider}" if current_provider else ""
        lines.append(f"The run would have continued on {current_model}{via}.")
    lines.append("Rerun when the pinned model is available, or repin the card.")
    return " ".join(lines)