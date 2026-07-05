import json
import os
from pathlib import Path
from typing import Optional

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

load_dotenv()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
APP_PIN            = os.environ.get("APP_PIN", "story")
SYSTEM_PROMPT      = (Path(__file__).parent / "system_prompt.md").read_text()
FRONTEND_DIR       = Path(__file__).parent.parent / "frontend"
MODEL              = "claude-sonnet-5"

# Origins allowed to call the API. In production set ALLOWED_ORIGIN to your
# deployed URL (e.g. https://storybuddy.up.railway.app). Locally stays open.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="Story Buddy API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

TOOLS = [
    {
        "name": "update_story_bible",
        "description": (
            "Call this whenever a story detail is established or changes: "
            "character name/trait, setting, main problem/goal, or a new plot beat. "
            "Only include the fields that changed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "character": {
                    "type": "string",
                    "description": "Character name and key trait, e.g. 'Mira — brave but terrified of the ocean'",
                },
                "setting": {
                    "type": "string",
                    "description": "Where and roughly when the story takes place",
                },
                "problem": {
                    "type": "string",
                    "description": "The central problem or goal the character faces",
                },
                "plot_beat": {
                    "type": "string",
                    "description": "A single new plot event to append to the story so far",
                },
                "writer_tip": {
                    "type": "string",
                    "description": "A short craft nudge to show in the Writer Tip card, in plain child-friendly language",
                },
            },
            "required": [],
        },
    },
    {
        "name": "suggest_line",
        "description": (
            "Cowrite mode only. Offer one or two sentences the child might add to their story. "
            "The child decides whether to insert it — never write it directly into the document."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The suggested story line(s), written in the child's voice and genre",
                }
            },
            "required": ["text"],
        },
    },
]


# ── Request / response models ─────────────────────────────────────────────────

class Message(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class StoryBible(BaseModel):
    character: Optional[str] = None
    setting: Optional[str] = None
    problem: Optional[str] = None
    plot_beats: list[str] = []
    writer_tip: Optional[str] = None


class ChatRequest(BaseModel):
    messages: list[Message]
    mode: str = "brainstorm"  # "brainstorm" | "cowrite"
    story_bible: StoryBible = StoryBible()


class StoryBibleUpdate(BaseModel):
    character: Optional[str] = None
    setting: Optional[str] = None
    problem: Optional[str] = None
    plot_beat: Optional[str] = None
    writer_tip: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    story_bible_update: Optional[StoryBibleUpdate] = None
    suggestion: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def build_system_prompt(mode: str, story_bible: StoryBible) -> str:
    parts = [SYSTEM_PROMPT]
    parts.append(f"\n\n## Current mode\n{mode.upper()}")

    bible_lines = []
    if story_bible.character:
        bible_lines.append(f"- Character: {story_bible.character}")
    if story_bible.setting:
        bible_lines.append(f"- Setting: {story_bible.setting}")
    if story_bible.problem:
        bible_lines.append(f"- Problem: {story_bible.problem}")
    if story_bible.plot_beats:
        beats = "\n".join(f"  {i+1}. {b}" for i, b in enumerate(story_bible.plot_beats))
        bible_lines.append(f"- Plot beats so far:\n{beats}")

    if bible_lines:
        parts.append("\n\n## Story bible (established so far)\n" + "\n".join(bible_lines))

    return "\n".join(parts)


def collect_tool_calls(response) -> tuple[Optional[StoryBibleUpdate], Optional[str], list[dict]]:
    """Extract tool results and build tool_result blocks to send back if needed."""
    bible_update = None
    suggestion   = None
    tool_results = []

    for block in response.content:
        if block.type != "tool_use":
            continue

        if block.name == "update_story_bible":
            inp = block.input
            bible_update = StoryBibleUpdate(
                character=inp.get("character"),
                setting=inp.get("setting"),
                problem=inp.get("problem"),
                plot_beat=inp.get("plot_beat"),
                writer_tip=inp.get("writer_tip"),
            )
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": "Story bible updated.",
            })

        elif block.name == "suggest_line":
            suggestion = block.input.get("text")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": "Suggestion noted.",
            })

    return bible_update, suggestion, tool_results


def extract_text(response) -> str:
    for block in response.content:
        if block.type == "text":
            return block.text
    return ""


# ── Request / response models (PIN) ───────────────────────────────────────────

class PinRequest(BaseModel):
    pin: str


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def serve_app():
    """Serve index.html with the PIN and API base injected from environment."""
    html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    injection = (
        f"<script>"
        f"window.__APP_PIN__ = {json.dumps(APP_PIN)};"
        f"window.__API_BASE__ = '';"   # same-origin when served by FastAPI
        f"</script>"
    )
    html = html.replace("</head>", injection + "\n</head>", 1)
    return HTMLResponse(html)


@app.post("/api/verify-pin")
@limiter.limit("10/minute")          # tight limit to block brute-force
async def verify_pin(request: Request, body: PinRequest):
    """Let the frontend verify the PIN server-side without exposing it in JS."""
    if body.pin != APP_PIN:
        raise HTTPException(status_code=401, detail="Wrong PIN")
    return {"ok": True}


@app.post("/api/chat", response_model=ChatResponse)
@limiter.limit("30/minute")
async def chat(request: Request, body: ChatRequest):
    if not ANTHROPIC_API_KEY or client is None:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not configured on the server")
    if body.mode not in ("brainstorm", "cowrite"):
        raise HTTPException(status_code=400, detail="mode must be 'brainstorm' or 'cowrite'")

    system   = build_system_prompt(body.mode, body.story_bible)
    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        bible_update, suggestion, tool_results = collect_tool_calls(response)
        reply = extract_text(response)

        # If Claude stopped to use tools without including a text reply, send the
        # tool results back and get the follow-up conversational response.
        if response.stop_reason == "tool_use" and not reply and tool_results:
            messages = messages + [
                {"role": "assistant", "content": response.content},
                {"role": "user",      "content": tool_results},
            ]
            follow_up = client.messages.create(
                model=MODEL,
                max_tokens=1024,
                system=system,
                tools=TOOLS,
                messages=messages,
            )
            reply = extract_text(follow_up)
            # pick up any additional tool calls from the follow-up (rare but possible)
            extra_bible, extra_suggestion, _ = collect_tool_calls(follow_up)
            if extra_bible:
                bible_update = extra_bible
            if extra_suggestion:
                suggestion = extra_suggestion

    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return ChatResponse(reply=reply, story_bible_update=bible_update, suggestion=suggestion)


# ── Static files (must come last — catches everything not matched above) ───────
# Serves style.css, app.js, and any other assets from the frontend directory.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
