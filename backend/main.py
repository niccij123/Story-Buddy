import json
import os
from pathlib import Path
from typing import Optional

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
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
                "character_name": {
                    "type": "string",
                    "description": (
                        "Name of a character being introduced or updated, e.g. 'Mira'. "
                        "Always pair with character_detail. If this name already exists in the "
                        "story bible, its detail is updated rather than duplicated — use the exact "
                        "same name to update an existing character."
                    ),
                },
                "character_detail": {
                    "type": "string",
                    "description": "Key trait(s)/role for the named character, e.g. 'brave but terrified of the ocean'",
                },
                "setting": {
                    "type": "string",
                    "description": (
                        "A place/time the story takes place, e.g. 'a floating city in the clouds'. "
                        "If the story moves somewhere new, add it as a new setting — don't repeat "
                        "settings already in the bible."
                    ),
                },
                "problem": {
                    "type": "string",
                    "description": (
                        "A central problem or goal in the story. If a new problem or goal emerges "
                        "(without replacing the earlier one), add it separately — don't repeat "
                        "problems already in the bible."
                    ),
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


class CharacterEntry(BaseModel):
    name: str
    detail: str = ""


class StoryBible(BaseModel):
    characters: list[CharacterEntry] = []
    settings: list[str] = []
    problems: list[str] = []
    plot_beats: list[str] = []
    writer_tip: Optional[str] = None


class ChatRequest(BaseModel):
    messages: list[Message]
    mode: str = "brainstorm"  # "brainstorm" | "cowrite"
    story_bible: StoryBible = StoryBible()
    story_body: str = ""


class StoryBibleUpdate(BaseModel):
    character_name: Optional[str] = None
    character_detail: Optional[str] = None
    setting: Optional[str] = None
    problem: Optional[str] = None
    plot_beat: Optional[str] = None
    writer_tip: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    story_bible_updates: list[StoryBibleUpdate] = []
    suggestion: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def build_system_prompt(mode: str, story_bible: StoryBible, story_body: str = "") -> str:
    parts = [SYSTEM_PROMPT]
    parts.append(f"\n\n## Current mode\n{mode.upper()}")

    bible_lines = []
    if story_bible.characters:
        for c in story_bible.characters:
            label = f"{c.name} — {c.detail}" if c.detail else c.name
            bible_lines.append(f"- Character: {label}")
    for s in story_bible.settings:
        bible_lines.append(f"- Setting: {s}")
    for p in story_bible.problems:
        bible_lines.append(f"- Problem: {p}")
    if story_bible.plot_beats:
        beats = "\n".join(f"  {i+1}. {b}" for i, b in enumerate(story_bible.plot_beats))
        bible_lines.append(f"- Plot beats so far:\n{beats}")

    if bible_lines:
        parts.append("\n\n## Story bible (established so far)\n" + "\n".join(bible_lines))

    if story_body.strip():
        parts.append(f"\n\n## Story so far (what the child has written)\n{story_body.strip()}")

    return "\n".join(parts)


def collect_tool_calls(response) -> tuple[list[StoryBibleUpdate], Optional[str], list[dict]]:
    """Extract tool results and build tool_result blocks to send back if needed."""
    bible_updates = []
    suggestion    = None
    tool_results  = []

    for block in response.content:
        if block.type != "tool_use":
            continue

        if block.name == "update_story_bible":
            inp = block.input
            bible_updates.append(StoryBibleUpdate(
                character_name=inp.get("character_name"),
                character_detail=inp.get("character_detail"),
                setting=inp.get("setting"),
                problem=inp.get("problem"),
                plot_beat=inp.get("plot_beat"),
                writer_tip=inp.get("writer_tip"),
            ))
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

    return bible_updates, suggestion, tool_results


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


def _asset_version() -> str:
    """Mtime of app.js, used to cache-bust static assets on every deploy so
    browsers can't keep serving a stale cached copy after a code change."""
    return str(int((FRONTEND_DIR / "app.js").stat().st_mtime))


def _app_html() -> str:
    html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    # Hide the pin gate and show the app directly — no client-side toggle needed
    html = html.replace('<div id="pin-gate" class="pin-gate">', '<div id="pin-gate" class="pin-gate" style="display:none">', 1)
    html = html.replace('<div id="app" class="app" hidden>', '<div id="app" class="app">', 1)
    v = _asset_version()
    html = html.replace('/static/style.css"', f'/static/style.css?v={v}"', 1)
    html = html.replace('/static/app.js"', f'/static/app.js?v={v}"', 1)
    return html


def _pin_page_html(error: bool = False) -> str:
    error_html = '<p class="pin-error">Wrong PIN — try again.</p>' if error else ''
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Story Buddy</title>
  <link rel="stylesheet" href="/static/style.css?v={_asset_version()}"/>
</head>
<body>
  <div class="pin-gate">
    <div class="pin-box">
      <div class="pin-logo">📖</div>
      <h1>Story Buddy</h1>
      <p>Enter the family PIN to start writing.</p>
      <form method="post" action="/api/verify-pin">
        <input name="pin" type="text" placeholder="PIN"
               autocomplete="off" maxlength="12" autofocus/>
        <button type="submit" class="btn-primary">Let's go</button>
      </form>
      {error_html}
    </div>
  </div>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def pin_page(error: str = ""):
    return HTMLResponse(_pin_page_html(error == "1"))


@app.get("/app", response_class=HTMLResponse)
def serve_app():
    return HTMLResponse(_app_html())


@app.post("/api/verify-pin")
@limiter.limit("10/minute")
async def verify_pin(request: Request, pin: str = Form(...)):
    if pin.strip() != APP_PIN.strip():
        return RedirectResponse("/?error=1", status_code=303)
    response = RedirectResponse("/app", status_code=303)
    response.set_cookie(
        key="sb_verified", value="1",
        path="/",
        httponly=True, samesite="lax", secure=True,
        max_age=60 * 60 * 24 * 30,   # 30 days
    )
    return response


@app.post("/api/chat", response_model=ChatResponse)
@limiter.limit("30/minute")
async def chat(request: Request, body: ChatRequest):
    if not ANTHROPIC_API_KEY or client is None:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not configured on the server")
    if body.mode not in ("brainstorm", "cowrite"):
        raise HTTPException(status_code=400, detail="mode must be 'brainstorm' or 'cowrite'")

    system   = build_system_prompt(body.mode, body.story_bible, body.story_body)
    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        bible_updates, suggestion, tool_results = collect_tool_calls(response)
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
            bible_updates += extra_bible
            if extra_suggestion:
                suggestion = extra_suggestion

    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return ChatResponse(reply=reply, story_bible_updates=bible_updates, suggestion=suggestion)


# ── Static files (must come last — catches everything not matched above) ───────
# Serves style.css, app.js, and any other assets from the frontend directory.
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
