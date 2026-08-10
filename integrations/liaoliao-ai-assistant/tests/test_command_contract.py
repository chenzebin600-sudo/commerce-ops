from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.command_contract import CommandContractError, validate_fill_draft_command


CONTRACT_PATH = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "customer-service"
    / "cs-fill-draft-v1.example.json"
)


def example_command() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_shared_fill_draft_contract_is_accepted_without_send_capability():
    command = example_command()

    validated = validate_fill_draft_command(
        command, expected_account_id="central-account-example"
    )

    assert validated.external_conversation_id == "liaoliao-conversation-example"
    assert validated.external_message_id == "liaoliao-message-example"
    assert validated.draft.startswith("Thanks for your message")
    assert validated.draft_content_digest == command["payload"]["expected"]["draftContentDigest"]
    assert command["payload"]["safety"]["automaticSend"] is False


def test_older_v1_fill_command_without_observation_digest_remains_fillable():
    command = example_command()
    command["payload"]["expected"].pop("draftContentDigest")

    validated = validate_fill_draft_command(
        command, expected_account_id="central-account-example"
    )

    assert validated.draft_content_digest == ""


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda command: command.update(accountId="another-account"), "ACCOUNT_SCOPE_MISMATCH"),
        (
            lambda command: command["payload"]["safety"].update(automaticSend=True),
            "UNSAFE_COMMAND_CONTRACT",
        ),
        (
            lambda command: command["payload"]["expected"].update(externalMessageId="newer-message"),
            "MESSAGE_ROUTE_MISMATCH",
        ),
        (
            lambda command: command["payload"].update(contractVersion="CS_FILL_DRAFT_V2"),
            "UNSUPPORTED_COMMAND_CONTRACT",
        ),
        (
            lambda command: command["payload"]["expected"].update(draftContentDigest="not-a-digest"),
            "INVALID_DRAFT_DIGEST",
        ),
    ],
)
def test_fill_draft_contract_fails_closed_on_scope_or_safety_drift(mutate, expected_code):
    command = copy.deepcopy(example_command())
    mutate(command)

    with pytest.raises(CommandContractError) as caught:
        validate_fill_draft_command(
            command, expected_account_id="central-account-example"
        )

    assert caught.value.code == expected_code
