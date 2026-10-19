"""A pinned model is an identity: a fallback may reroute it, never swap it.

Regression for the card pinned to ``claude-opus-5-5`` (anthropic) that ran on
``deepseek-v4.1-flash`` (openrouter) because the fallback chain treated the pin
as a preference. Silence was the bug.
"""

from unittest.mock import MagicMock, patch

import pytest

from agent.model_pin import (
    ModelPinRefusedError,
    model_identity,
    pin_refuses,
)
from agent.prompt_builder import KANBAN_GUIDANCE
from run_agent import AIAgent


def _make_agent(**kwargs):
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://api.anthropic.com",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            **kwargs,
        )
        agent.client = MagicMock()
        return agent


def _mock_client(base_url="https://openrouter.ai/api/v1"):
    client = MagicMock()
    client.base_url = base_url
    client.api_key = "fb-key"
    return client


# Route equivalence: the same model travels under a vendor prefix and dot notation.


def test_model_identity_folds_vendor_prefix_and_dots():
    assert model_identity("claude-opus-5-5") == model_identity("anthropic/claude-opus-5.5")


def test_model_identity_keeps_different_models_apart():
    assert model_identity("claude-opus-5-5") != model_identity("deepseek/deepseek-v4.1-flash")
    assert model_identity("claude-opus-5-5") != model_identity("claude-opus-5")


def test_an_explicit_model_is_recorded_as_the_pin():
    agent = _make_agent(model="claude-opus-5-5", provider="anthropic", model_pinned=True)
    assert agent._model_pin == {"provider": "anthropic", "model": "claude-opus-5-5"}


def test_no_explicit_model_means_no_pin():
    agent = _make_agent(model="claude-opus-5-5", provider="anthropic")
    assert agent._model_pin is None


# Runtime fallback: the refusal, and the one route change that is allowed.


def test_pinned_run_refuses_a_fallback_to_another_model():
    agent = _make_agent(
        model="claude-opus-5-5",
        provider="anthropic",
        model_pinned=True,
        fallback_model=[
            {"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash"},
        ],
    )
    with patch(
        "agent.auxiliary_client.resolve_provider_client",
        return_value=(_mock_client(), "deepseek/deepseek-v4.1-flash"),
    ):
        with pytest.raises(ModelPinRefusedError) as excinfo:
            agent._try_activate_fallback()

    message = str(excinfo.value)
    assert message.startswith("MODEL PIN REFUSED:")
    assert "claude-opus-5-5" in message
    assert "Refusing to continue on another model" in message
    assert "deepseek/deepseek-v4.1-flash" in message
    # The run did not silently continue on the other model.
    assert agent.model == "claude-opus-5-5"
    assert not getattr(agent, "_fallback_activated", False)


def test_pinned_run_allows_the_same_model_on_another_route():
    agent = _make_agent(
        model="claude-opus-5-5",
        provider="anthropic",
        model_pinned=True,
        fallback_model=[
            {"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash"},
            {"provider": "openrouter", "model": "anthropic/claude-opus-5.5"},
        ],
    )
    with patch(
        "agent.auxiliary_client.resolve_provider_client",
        return_value=(_mock_client(), "anthropic/claude-opus-5.5"),
    ):
        assert agent._try_activate_fallback() is True

    assert agent.provider == "openrouter"
    assert model_identity(agent.model) == model_identity("claude-opus-5-5")


def test_unpinned_run_still_falls_back():
    agent = _make_agent(
        model="claude-opus-5-5",
        provider="anthropic",
        fallback_model=[{"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash"}],
    )
    with patch(
        "agent.auxiliary_client.resolve_provider_client",
        return_value=(_mock_client(), "deepseek/deepseek-v4.1-flash"),
    ):
        assert agent._try_activate_fallback() is True

    assert agent.model == "deepseek/deepseek-v4.1-flash"


def test_pin_refuses_only_a_different_model():
    agent = _make_agent(model="claude-opus-5-5", provider="anthropic", model_pinned=True)
    assert pin_refuses(agent, "openrouter", "anthropic/claude-opus-5.5") is False
    assert pin_refuses(agent, "openrouter", "gpt-5") is True


def test_fallback_reason_is_named_in_the_refusal():
    agent = _make_agent(model="claude-opus-5-5", provider="anthropic", model_pinned=True)
    agent._model_pin_refusals = [("openrouter", "serves deepseek, not the pinned model")]
    from agent.model_pin import pin_refusal_error

    error = pin_refusal_error(agent, "rate limit")
    assert "rate limit" in str(error)


# The brief: a worker must compare its own model against the card's pin.


def test_worker_brief_tells_the_worker_to_check_its_model():
    assert "NOT THE PINNED MODEL" in KANBAN_GUIDANCE
    assert "model_override" in KANBAN_GUIDANCE