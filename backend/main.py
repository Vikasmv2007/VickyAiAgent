"""
main.py - FastAPI entrypoint for Vicky Python backend.
Run locally:
  uvicorn main:app --reload --port 8000
"""

import os
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from pydantic import BaseModel

from agent import run_agent, search_hackathons
from calendar_tools import create_calendar_event, delete_event, list_events
from db import (
    get_primary_google_account,
    init_db,
    list_google_accounts,
    remove_google_account,
    save_google_account,
)
from gmail_tools import scan_all_inboxes
from scheduler import start_scheduler
from telegram_bot import TelegramNotifier, build_telegram_app

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    tg_app = build_telegram_app()
    if tg_app:
        await tg_app.initialize()
        await tg_app.start()
        await tg_app.updater.start_polling()
    scheduler = start_scheduler(tg_app)
    app.state.telegram_app = tg_app
    app.state.scheduler = scheduler
    yield
    scheduler.shutdown(wait=False)
    if tg_app:
        await tg_app.updater.stop()
        await tg_app.stop()
        await tg_app.shutdown()


app = FastAPI(title="Vicky Personal AI Assistant", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AssistantRequest(BaseModel):
    message: str


class CreateEventRequest(BaseModel):
    title: str
    date: str
    startTime: str = "10:00"
    durationMinutes: int = 60
    location: str = ""
    link: str = ""
    description: str = ""
    skipDuplicateCheck: bool = False


@app.get("/api/health")
def health():
    return {"ok": True, "timezone": "Asia/Kolkata"}


@app.get("/auth/google/start")
def google_oauth_start():
    """Redirect user to Google OAuth consent screen to connect Calendar + Gmail."""
    client_config = {
        "web": {
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    flow = Flow.from_client_config(
        client_config,
        scopes=SCOPES,
        redirect_uri=os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback"),
    )
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent select_account",
    )
    return RedirectResponse(auth_url)


@app.get("/auth/google/callback")
def google_oauth_callback(code: str):
    """Exchange OAuth code for refresh token and save in SQLite."""
    client_config = {
        "web": {
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    flow = Flow.from_client_config(
        client_config,
        scopes=SCOPES,
        redirect_uri=os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback"),
    )
    flow.fetch_token(code=code)
    creds = flow.credentials

    oauth2_svc = build("oauth2", "v2", credentials=creds, cache_discovery=False)
    profile = oauth2_svc.userinfo().get().execute()
    email = profile.get("email")
    name = profile.get("name", email)

    if email and creds.refresh_token:
        save_google_account(email=email, display_name=name, refresh_token=creds.refresh_token)

    return RedirectResponse(os.getenv("FRONTEND_URL", "http://localhost:3000"))


@app.get("/api/accounts")
def get_accounts():
    accounts = list_google_accounts()
    # Never expose raw refresh tokens to the frontend
    return [
        {
            "email": a["email"],
            "displayName": a["display_name"],
            "isPrimary": bool(a["is_primary"]),
        }
        for a in accounts
    ]


@app.delete("/api/accounts/{email}")
def disconnect_account(email: str):
    remove_google_account(email)
    return {"removed": True}


@app.get("/api/calendar/events")
def get_calendar_events(range: Optional[str] = Query("upcoming")):
    primary = get_primary_google_account()
    if not primary:
        raise HTTPException(status_code=401, detail="No Google account connected.")
    days = 1 if range == "today" else (7 if range == "week" else 30)
    return {"events": list_events(primary["refresh_token"], days_ahead=days)}


@app.post("/api/calendar/events")
def post_calendar_event(body: CreateEventRequest):
    primary = get_primary_google_account()
    if not primary:
        raise HTTPException(status_code=401, detail="No Google account connected.")
    res = create_calendar_event(
        refresh_token=primary["refresh_token"],
        title=body.title,
        date_ymd=body.date,
        start_time=body.startTime,
        duration_minutes=body.durationMinutes,
        location=body.location,
        link=body.link,
        description=body.description,
        skip_duplicate_check=body.skipDuplicateCheck,
    )
    if res.get("duplicate"):
        raise HTTPException(status_code=409, detail=res["existing"])
    return res


@app.delete("/api/calendar/events/{event_id}")
def remove_calendar_event(event_id: str):
    primary = get_primary_google_account()
    if not primary:
        raise HTTPException(status_code=401, detail="No Google account connected.")
    delete_event(primary["refresh_token"], event_id)
    return {"deleted": True}


@app.post("/api/assistant")
def assistant_endpoint(req: AssistantRequest):
    return run_agent(req.message, auto_commit_calendar=False)


@app.post("/api/gmail/scan")
async def trigger_gmail_scan():
    tg_app = getattr(app.state, "telegram_app", None)
    notifier = TelegramNotifier(tg_app) if tg_app else None
    return await scan_all_inboxes(telegram_notifier=notifier)


@app.post("/api/hackathons/digest")
def hackathon_digest(query: Optional[str] = None):
    return {"items": search_hackathons(query or "")}
