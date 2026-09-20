import logging
import os

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)

# Instrumentation must initialize before a2a-sdk is imported: OTel's Starlette
# instrumentor patches by rebinding starlette.applications.Starlette.
from telemetry import init_telemetry

init_telemetry(service_name="severance-broker")

import click
import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill
from starlette.middleware.cors import CORSMiddleware

from agent import BrokerAgent
from agent_executor import BrokerAgentExecutor

logger = logging.getLogger(__name__)


@click.command()
@click.option("--host", default="localhost")
@click.option("--port", default=8000)
def main(host, port):
    """Starts the Severance Broker A2A server."""
    capabilities = AgentCapabilities(streaming=True)
    skills = [
        AgentSkill(
            id="shop-and-score",
            name="Shop and score providers",
            description="Discover current pricing pages, scrape plan rows, and rank them against a Surveyor capacity spec. Ceiling, region allowlist, and spec floor are enforced in Python.",
            tags=["procurement", "pricing", "hetzner", "digitalocean", "vultr"],
            examples=["Shop a capacity spec with ceiling ₹1500"],
        ),
        AgentSkill(
            id="mint-cart-mandate",
            name="Mint signed cart mandate",
            description="Re-check every constraint and HMAC-SHA256 sign a severance.cart_mandate/v1. Refuses over-ceiling winners.",
            tags=["mandate", "hmac", "approval"],
            examples=["Mint a cart mandate for the winning Hetzner plan"],
        ),
        AgentSkill(
            id="human-approval-gate",
            name="Human approval gate",
            description="Park the A2A task in input-required until APPROVE MND-… in the same session.",
            tags=["hitl", "approval", "a2a"],
            examples=["APPROVE MND-7F3A2C"],
        ),
    ]
    agent_url = os.getenv("HOST_OVERRIDE", f"http://{host}:{port}/")
    agent_card = AgentCard(
        name="severance-broker",
        description="Vendor-adversarial procurement. Shops live VPS pricing, scores under hard rupee constraints in code, mints one signed cart mandate, and waits for a human. Cannot buy or provision.",
        url=agent_url,
        version="0.1.0",
        default_input_modes=BrokerAgent.SUPPORTED_CONTENT_TYPES,
        default_output_modes=BrokerAgent.SUPPORTED_CONTENT_TYPES,
        capabilities=capabilities,
        skills=skills,
    )
    request_handler = DefaultRequestHandler(
        agent_executor=BrokerAgentExecutor(),
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
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
