"""
openHarness Python SDK — drive the `oh` CLI from Python.

Quick start::

    import asyncio
    from openharness import query, TextDelta

    async def main() -> None:
        async for event in query("What is 2+2?", model="ollama/qwen3:4b", max_turns=1):
            if isinstance(event, TextDelta):
                print(event.content, end="")

    asyncio.run(main())

Custom Python tools::

    from openharness import OpenHarnessClient, tool

    @tool
    async def get_weather(city: str) -> str:
        '''Fetch the current weather for a city.'''
        return f"Sunny in {city}"

    async with OpenHarnessClient(tools=[get_weather]) as client:
        async for event in await client.send("What's the weather in Paris?"):
            print(event)

Custom permission gate::

    async def gate(ctx):
        return "allow" if ctx["toolName"] != "Bash" else "deny"

    async with OpenHarnessClient(can_use_tool=gate) as client:
        async for event in await client.send("List the current directory"):
            print(event)
"""

from .client import OpenHarnessClient
from .events import (
    CostUpdate,
    ErrorEvent,
    Event,
    HookDecision,
    SessionStart,
    TextDelta,
    ToolEnd,
    ToolStart,
    TurnComplete,
    TurnStart,
    TurnStop,
    parse_event,
)
from .exceptions import OhBinaryNotFoundError, OpenHarnessError
from .options import OpenHarnessOptions
from .query import query
from .tools import tool

__version__ = "0.5.0"

__all__ = [
    "CostUpdate",
    "ErrorEvent",
    "Event",
    "HookDecision",
    "OhBinaryNotFoundError",
    "OpenHarnessClient",
    "OpenHarnessError",
    "OpenHarnessOptions",
    "SessionStart",
    "TextDelta",
    "ToolEnd",
    "ToolStart",
    "TurnComplete",
    "TurnStart",
    "TurnStop",
    "__version__",
    "parse_event",
    "query",
    "tool",
]
