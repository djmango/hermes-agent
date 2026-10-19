"""The oneshot path (-z) pins an explicitly named model like the chat path does.

A pinned model that hit a rate limit used to continue the single turn on the fallback chain's
model with no word said (the t_70c2167f incident, reproduced on -z). The pin is what makes that
a refusal instead of a silent swap, so -z must pass it through.
"""

from unittest.mock import MagicMock, patch

from hermes_cli import oneshot


def _run(model):
    agent = MagicMock()
    agent.run_conversation.return_value = {"final_response": "ok"}
    with (
        patch("hermes_cli.config.load_config", return_value={"model": {"default": "m"}}),
        patch("hermes_cli.oneshot.get_fallback_chain", return_value=[]),
        patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value={"provider": "anthropic", "api_key": "k", "base_url": "https://x"},
        ),
        patch("hermes_cli.tools_config._get_platform_tools", return_value=set()),
        patch("hermes_cli.oneshot._create_session_db_for_oneshot", return_value=None),
        patch("hermes_cli.oneshot._load_resume_target", return_value=(None, None, None)),
        patch("hermes_cli.oneshot._build_preloaded_skills_prompt", return_value=""),
        patch("hermes_cli.mcp_startup.ensure_mcp_discovery_before_agent_build"),
        patch("run_agent.AIAgent", return_value=agent) as agent_cls,
    ):
        oneshot._run_agent("hi", model=model)
    return agent_cls.call_args.kwargs


def test_oneshot_pins_an_explicit_model():
    assert _run("claude-opus-5-5")["model_pinned"] is True


def test_oneshot_leaves_a_configured_default_unpinned(monkeypatch):
    monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
    assert _run(None)["model_pinned"] is False
