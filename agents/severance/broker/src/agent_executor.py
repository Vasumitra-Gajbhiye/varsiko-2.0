"""A2A task lifecycle. Shopping completes; APPROVE remains for a later purchase agent."""

from __future__ import annotations

import json
import logging

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import InternalError, Part, TaskState, TextPart, UnsupportedOperationError
from a2a.utils import new_agent_text_message, new_task
from a2a.utils.errors import ServerError

from agent import BrokerAgent
from broker.approval import PendingGate, evaluate_approval, parse_approve
from broker.card import render_approval_card, render_shop_card
from broker.contracts import looks_like_spec, inbound_text
from broker.emit import emit_to_pilot
from broker.pipeline import run_pipeline

logger = logging.getLogger(__name__)


def _json_part(text: str) -> Part:
    try:
        from a2a.types import DataPart

        data = json.loads(text)
        if isinstance(data, dict):
            return Part(root=DataPart(data=data))
    except Exception:
        pass
    return Part(root=TextPart(text=text))


def _nasiko_token(context: RequestContext) -> str | None:
    call_context = getattr(context, "call_context", None)
    if not call_context:
        return None
    state = getattr(call_context, "state", None) or {}
    headers = state.get("headers") if isinstance(state, dict) else {}
    if not headers:
        return None
    return headers.get("x-nasiko-agent-token") or headers.get("X-Nasiko-Agent-Token")


class BrokerAgentExecutor(AgentExecutor):
    def __init__(self) -> None:
        self.agent = BrokerAgent()
        self.pending: dict[str, PendingGate] = {}

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        query = inbound_text(context.get_user_input() or "", getattr(context, "message", None))
        task = context.current_task
        if not task:
            task = new_task(context.message)
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)
        token = _nasiko_token(context)
        context_id = task.context_id
        parked = self.pending.get(context_id)

        try:
            if parse_approve(query) or (parked and query.strip().lower() in {"yes", "y", "ok", "approve"}):
                await self._handle_approval(query, parked, updater, task, token)
                return

            if looks_like_spec(query):
                await updater.update_status(
                    TaskState.working,
                    new_agent_text_message("Shopping providers...", task.context_id, task.id),
                )
                result = run_pipeline(query)
                if result.error or result.mandate is None:
                    text = result.as_narration()
                    await updater.add_artifact([Part(root=TextPart(text=text))], name="broker_error")
                    await updater.complete()
                    return
                gate = PendingGate(
                    mandate=result.mandate,
                    card=result.card or render_approval_card(result.mandate),
                    winner=result.winner,
                    spec=result.spec,
                    spec_hash=result.spec_hash or "",
                    ranked=result.ranked,
                )
                self.pending[context_id] = gate
                shop = {
                    "schema": "severance.shop_result/v1",
                    "mandate_id": result.mandate.mandate_id,
                    **(result.ranked.as_dict() if result.ranked else {}),
                }
                shop_text = json.dumps(shop, default=str)
                mandate_text = result.mandate.model_dump_json(by_alias=True)
                card = render_shop_card(shop, result.mandate)
                await updater.add_artifact(
                    [Part(root=TextPart(text=mandate_text)), _json_part(mandate_text)],
                    name="cart_mandate",
                )
                await updater.add_artifact(
                    [Part(root=TextPart(text=shop_text)), _json_part(shop_text)],
                    name="shop_result",
                )
                await updater.add_artifact(
                    [Part(root=TextPart(text=card))],
                    name="shop_card",
                )
                await updater.update_status(
                    TaskState.working,
                    new_agent_text_message(card, task.context_id, task.id),
                )
                await updater.complete()
                return

            extra = ""
            if parked:
                extra = (
                    f"A mandate is parked in this session: {parked.mandate.mandate_id}. "
                    f"Ceiling ₹{parked.spec.constraints.ceiling_inr_monthly}. "
                    "You cannot change these numbers. Approval is recorded in executor state, "
                    f"not by you. To approve, the human must send APPROVE {parked.mandate.mandate_id}."
                )
            async for item in self.agent.stream(
                query,
                context_id,
                extra_system=extra,
                approved=bool(parked and parked.approved),
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
                        name="broker_reply",
                    )
                    await updater.complete()
                    break
        except Exception as exc:
            logger.error("Error: %s", exc)
            raise ServerError(error=InternalError()) from exc

    async def _handle_approval(self, query, parked, updater, task, token) -> None:
        headers = {"x-nasiko-agent-token": token} if token else None
        outcome = evaluate_approval(parked, query)
        if outcome.kind == "approved" and outcome.pending is not None:
            self.pending[task.context_id] = outcome.pending
            emitted = emit_to_pilot(
                outcome.pending.mandate,
                approved=True,
                headers=headers,
            )
            text = outcome.message + "\n\n" + f"emit_to_pilot: {emitted}"
            if isinstance(emitted, dict) and emitted.get("error"):
                # Not released. Leave it parked so the human can retry the same APPROVE.
                await updater.update_status(
                    TaskState.input_required,
                    new_agent_text_message(text, task.context_id, task.id),
                    final=True,
                )
                return
            outcome.pending.emitted = True
            await updater.add_artifact([Part(root=TextPart(text=text))], name="approval")
            await updater.complete()
            return
        if outcome.kind == "expired_remint" and outcome.pending is not None:
            self.pending[task.context_id] = outcome.pending
            await updater.add_artifact(
                [Part(root=TextPart(text=outcome.pending.mandate.model_dump_json(by_alias=True)))],
                name="cart_mandate",
            )
            await updater.update_status(
                TaskState.input_required,
                new_agent_text_message(
                    outcome.message + "\n\n" + outcome.pending.card,
                    task.context_id,
                    task.id,
                ),
                final=True,
            )
            return
        await updater.update_status(
            TaskState.input_required,
            new_agent_text_message(outcome.message, task.context_id, task.id),
            final=True,
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise ServerError(error=UnsupportedOperationError())
