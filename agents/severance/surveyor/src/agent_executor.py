"""A2A task lifecycle: streaming stages, input-required for ceiling/project."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import InternalError, Part, TaskState, TextPart, UnsupportedOperationError
from a2a.utils import new_agent_text_message, new_task
from a2a.utils.errors import ServerError

from agent import SurveyorAgent
from surveyor.emit import render_card
from surveyor.intake import Intake, looks_like_survey, merge_intake, parse_intake
from surveyor.pipeline import run_pipeline

logger = logging.getLogger(__name__)


def _nasiko_token(context: RequestContext) -> str | None:
    call_context = getattr(context, "call_context", None)
    if not call_context:
        return None
    state = getattr(call_context, "state", None) or {}
    headers = state.get("headers") if isinstance(state, dict) else {}
    if not headers:
        return None
    return headers.get("x-nasiko-agent-token") or headers.get("X-Nasiko-Agent-Token")


def _json_part(text: str) -> Part:
    try:
        from a2a.types import DataPart

        data = json.loads(text)
        if isinstance(data, dict):
            return Part(root=DataPart(data=data))
    except Exception:
        pass
    return Part(root=TextPart(text=text))


@dataclass
class PendingSurvey:
    intake: Intake
    park: str
    document: dict[str, Any] | None = None
    card: str = ""
    candidates: list[dict[str, str]] = field(default_factory=list)


class SurveyorAgentExecutor(AgentExecutor):
    def __init__(self) -> None:
        self.agent = SurveyorAgent()
        self.pending: dict[str, PendingSurvey] = {}

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        query = context.get_user_input()
        task = context.current_task
        if not task:
            task = new_task(context.message)
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)
        token = _nasiko_token(context)
        context_id = task.context_id
        parked = self.pending.get(context_id)

        try:
            intake = parse_intake(query, allow_bare_ceiling=bool(parked and parked.park == "ceiling"))
            if parked:
                intake = merge_intake(parked.intake, intake)

            should_run = looks_like_survey(query) or parked is not None
            if parked and parked.park == "project":
                should_run = should_run or bool(intake.vercel_project)
            if parked and parked.park == "ceiling":
                should_run = should_run or intake.ceiling_inr_monthly is not None

            if should_run and (intake.repo_url or parked):
                await self._run_survey(intake, updater, task, context_id)
                return

            extra = ""
            if parked:
                extra = (
                    f"A survey is parked in this session for {parked.intake.repo_url}. "
                    f"Waiting for {parked.park}. You cannot invent a ceiling."
                )
            async for item in self.agent.stream(
                query,
                context_id,
                extra_system=extra,
                nasiko_token=token,
            ):
                if not item["is_task_complete"] and not item["require_user_input"]:
                    await updater.update_status(
                        TaskState.working,
                        new_agent_text_message(item["content"], task.context_id, task.id),
                    )
                elif item["require_user_input"]:
                    await updater.update_status(
                        TaskState.input_required,
                        new_agent_text_message(item["content"], task.context_id, task.id),
                        final=True,
                    )
                    break
                else:
                    await updater.add_artifact(
                        [Part(root=TextPart(text=item["content"]))],
                        name="surveyor_reply",
                    )
                    await updater.complete()
                    break
        except Exception as exc:
            logger.error("Error: %s", exc)
            raise ServerError(error=InternalError()) from exc

    async def _run_survey(self, intake: Intake, updater, task, context_id: str) -> None:
        await updater.update_status(
            TaskState.working,
            new_agent_text_message("Surveying...", task.context_id, task.id),
        )
        result = run_pipeline(intake, on_stage=lambda name: None)
        for name in result.stages:
            await updater.update_status(
                TaskState.working,
                new_agent_text_message(name.replace("_", " ") + "...", task.context_id, task.id),
            )

        if result.error and result.document is None:
            await updater.add_artifact(
                [Part(root=TextPart(text=result.as_narration()))],
                name="surveyor_error",
            )
            await updater.complete()
            return

        if result.document is not None:
            payload = json.dumps(result.document, default=str)
            await updater.add_artifact([_json_part(payload)], name="surveyor_result.json")
            await updater.add_artifact(
                [Part(root=TextPart(text=result.card or render_card(result.document)))],
                name="surveyor_card",
            )

        if result.park:
            self.pending[context_id] = PendingSurvey(
                intake=intake,
                park=result.park,
                document=result.document,
                card=result.card,
                candidates=result.candidates,
            )
            await updater.update_status(
                TaskState.input_required,
                new_agent_text_message(
                    (result.card + "\n\n" + result.park_message).strip(),
                    task.context_id,
                    task.id,
                ),
                final=True,
            )
            return

        self.pending.pop(context_id, None)
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise ServerError(error=UnsupportedOperationError())
