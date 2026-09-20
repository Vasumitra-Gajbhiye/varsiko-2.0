import logging
import os

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)

# Instrumentation must initialize before a2a-sdk is imported: OTel's Starlette
# instrumentor patches by rebinding starlette.applications.Starlette.
from telemetry import init_telemetry

init_telemetry(service_name="severance-surveyor")

import click
import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill
from starlette.middleware.cors import CORSMiddleware

from agent import SurveyorAgent
from agent_executor import SurveyorAgentExecutor

logger = logging.getLogger(__name__)


@click.command()
@click.option("--host", default="localhost")
@click.option("--port", default="8000")
def main(host, port):
    """Starts the Severance Surveyor A2A server."""
    capabilities = AgentCapabilities(streaming=True)
    skills = [
        AgentSkill(
            id="survey-vercel-project",
            name="Survey a Vercel project",
            description="Resolve the Vercel project for a GitHub repo, pull billing/metrics/env/deployments, and emit a capacity spec. The ceiling is never inferred.",
            tags=["vercel", "capacity", "billing", "observability"],
            examples=["Survey https://github.com/acme/victim-app with ceiling ₹1500"],
        ),
        AgentSkill(
            id="inventory-lockin",
            name="Inventory Vercel lock-in",
            description="Statically scan a Next.js tree for Vercel lock-in. Rules table, not an LLM.",
            tags=["lock-in", "nextjs", "self-host"],
            examples=["Scan this repo for Vercel lock-in"],
        ),
    ]
    agent_url = os.getenv("HOST_OVERRIDE", f"http://{host}:{port}/")
    agent_card = AgentCard(
        name="severance-surveyor",
        description="Read-only Vercel/GitHub surveyor. Inventories lock-in, derives a capacity spec, writes one severance.capacity_spec/v1 file. Cannot spend, deploy, or run the target repo.",
        url=agent_url,
        version="0.1.0",
        default_input_modes=SurveyorAgent.SUPPORTED_CONTENT_TYPES,
        default_output_modes=SurveyorAgent.SUPPORTED_CONTENT_TYPES,
        capabilities=capabilities,
        skills=skills,
    )
    request_handler = DefaultRequestHandler(
        agent_executor=SurveyorAgentExecutor(),
        task_store=InMemoryTaskStore(),
    )
    server = A2AStarletteApplication(agent_card=agent_card, http_handler=request_handler)
    app = server.build()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    uvicorn.run(app, host=host, port=int(port))


if __name__ == "__main__":
    main()
