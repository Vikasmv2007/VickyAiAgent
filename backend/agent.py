"""
agent.py - Gemini AI brain with Function Calling for Vicky.
Tools: create_calendar_event, list_events, delete_event, search_hackathons, scan_emails.
"""

import json
import os
from datetime import datetime
from typing import Any, Dict, List

import pytz
from google import genai
from google.genai import types
from tavily import TavilyClient

from calendar_tools import create_calendar_event, delete_event, list_events
from db import get_primary_google_account, is_hackathon_seen, mark_hackathon_seen

IST = pytz.timezone("Asia/Kolkata")


def search_hackathons(query: str = "") -> List[Dict[str, Any]]:
    """
    Search the web using Tavily API for upcoming tech events & hackathons
    (India, Bangalore, Devfolio, Unstop, MLH, Devpost, online) and skip seen events.
    """
    tavily_key = os.getenv("TAVILY_API_KEY")
    if not tavily_key:
        return []

    tavily = TavilyClient(api_key=tavily_key)
    search_q = (
        query.strip()
        or "upcoming hackathons India Bangalore online Devfolio Unstop MLH Devpost 2026"
    )
    raw = tavily.search(query=search_q, search_depth="basic", max_results=10)
    snippets = [
        f"Title: {r.get('title')}\nURL: {r.get('url')}\nDetails: {r.get('content')}"
        for r in raw.get("results", [])
    ]

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    now_str = datetime.now(IST).strftime("%Y-%m-%d")
    prompt = f"""Today's IST date is {now_str}.
From these web search results, extract up to 5 real upcoming hackathons or tech events in India or online with upcoming deadlines.
Return a JSON array of objects with keys: name, event_date ("YYYY-MM-DD"), deadline (string), location (string), link (string), description (1 concise sentence).

Results:
{chr(10).join(snippets)}"""

    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )

    try:
        items = json.loads(resp.text or "[]")
    except json.JSONDecodeError:
        return []

    fresh: List[Dict[str, Any]] = []
    for item in items:
        dedup_key = (item.get("link") or item.get("name", "")).strip().lower()
        if not dedup_key or is_hackathon_seen(dedup_key):
            continue
        mark_hackathon_seen(dedup_key, item.get("name", ""), item.get("link", ""))
        fresh.append(item)
        if len(fresh) >= 5:
            break
    return fresh


# Function Declarations exposed to Gemini
TOOL_DECLARATIONS = [
    types.FunctionDeclaration(
        name="create_calendar_event",
        description="Extract event fields to add an event to Google Calendar in Asia/Kolkata.",
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "date": {"type": "string", "description": "YYYY-MM-DD in IST"},
                "start_time": {"type": "string", "description": "HH:MM 24-hour IST"},
                "duration_minutes": {"type": "integer"},
                "location": {"type": "string"},
                "link": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["title", "date", "start_time"],
        },
    ),
    types.FunctionDeclaration(
        name="list_events",
        description="List upcoming Google Calendar events.",
        parameters={
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "description": "1 for today, 7 for week"}
            },
            "required": ["days_ahead"],
        },
    ),
    types.FunctionDeclaration(
        name="delete_event",
        description="Delete a calendar event matching title.",
        parameters={
            "type": "object",
            "properties": {"event_title": {"type": "string"}},
            "required": ["event_title"],
        },
    ),
    types.FunctionDeclaration(
        name="search_hackathons",
        description="Search the web for upcoming hackathons and tech events.",
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
    ),
    types.FunctionDeclaration(
        name="scan_emails",
        description="Scan connected Gmail inboxes for event confirmations.",
        parameters={"type": "object", "properties": {}},
    ),
]


def run_agent(user_message: str, auto_commit_calendar: bool = False) -> Dict[str, Any]:
    """
    Process natural language with Gemini function calling.
    When auto_commit_calendar=False (web preview flow), returns a draft for user confirmation.
    """
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    now_ist = datetime.now(IST).strftime("%A, %Y-%m-%d %H:%M IST")

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=user_message,
        config=types.GenerateContentConfig(
            system_instruction=(
                f"You are Vicky, a helpful personal AI assistant for events and hackathons. "
                f"Current time: {now_ist}. Always assume Asia/Kolkata timezone."
            ),
            tools=[types.Tool(function_declarations=TOOL_DECLARATIONS)],
        ),
    )

    calls = response.function_calls or []
    if not calls:
        return {"action": "reply", "reply": response.text or "How can I help with your schedule?"}

    call = calls[0]
    args = dict(call.args or {})
    primary = get_primary_google_account()

    if call.name == "create_calendar_event":
        title = str(args.get("title") or "Untitled Event").strip()
        date_ymd = str(args.get("date") or datetime.now(IST).strftime("%Y-%m-%d")).strip()
        start_time = str(args.get("start_time") or "10:00").strip()
        safe_draft = {
            **args,
            "title": title,
            "date": date_ymd,
            "start_time": start_time,
        }
        if not auto_commit_calendar or not primary:
            return {"action": "confirm_event", "draft_event": safe_draft}
        res = create_calendar_event(
            refresh_token=primary["refresh_token"],
            title=title,
            date_ymd=date_ymd,
            start_time=start_time,
            duration_minutes=int(args.get("duration_minutes") or 60),
            location=args.get("location", ""),
            link=args.get("link", ""),
            description=args.get("description", ""),
        )
        if res.get("duplicate"):
            return {
                "action": "duplicate",
                "reply": f"'{title}' is already on your calendar for {date_ymd}.",
            }
        return {
            "action": "created",
            "event": res["event"],
            "reply": f"Added '{title}' on {date_ymd} at {start_time} IST.",
        }

    if call.name == "list_events":
        if not primary:
            return {"action": "needs_auth", "reply": "Connect a Google account first."}
        days = int(args.get("days_ahead") or 7)
        events = list_events(primary["refresh_token"], days_ahead=days)
        return {"action": "list_events", "events": events}

    if call.name == "delete_event":
        if not primary:
            return {"action": "needs_auth", "reply": "Connect a Google account first."}
        target = args.get("event_title", "").lower()
        events = list_events(primary["refresh_token"], days_ahead=60)
        match = next((e for e in events if target in e["title"].lower()), None)
        if not match:
            return {"action": "reply", "reply": f"No upcoming event matched '{target}'."}
        delete_event(primary["refresh_token"], match["id"])
        return {"action": "deleted", "reply": f"Deleted '{match['title']}'."}

    if call.name == "search_hackathons":
        items = search_hackathons(args.get("query", ""))
        return {"action": "hackathon_digest", "items": items}

    if call.name == "scan_emails":
        return {"action": "trigger_email_scan"}

    return {"action": "reply", "reply": response.text or "Done."}
