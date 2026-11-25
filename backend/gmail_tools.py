"""
gmail_tools.py - Read-only multi-account Gmail scanner for Vicky.
Scans new emails from the last 24 hours across all connected Google accounts,
uses Gemini to classify event/hackathon confirmations, auto-adds confident matches
with [Auto], and asks the user via Telegram for uncertain matches.
"""

import base64
import json
import os
import re
import uuid
from typing import Any, Dict, List

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from google import genai
from google.genai import types

from calendar_tools import create_calendar_event
from db import (
    get_primary_google_account,
    is_email_processed,
    list_google_accounts,
    mark_email_processed,
    save_pending_event,
)


def _gmail_service(refresh_token: str):
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.getenv("GOOGLE_CLIENT_ID"),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    )
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _extract_text(payload: Dict[str, Any]) -> str:
    """Extract plain text body from a Gmail message payload."""
    mime = payload.get("mimeType", "")
    body_data = payload.get("body", {}).get("data")
    if mime == "text/plain" and body_data:
        return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="ignore")
    for part in payload.get("parts", []):
        found = _extract_text(part)
        if found:
            return found
    if body_data:
        raw_html = base64.urlsafe_b64decode(body_data).decode("utf-8", errors="ignore")
        cleaned = re.sub(r"<[^>]+>", " ", raw_html)
        return re.sub(r"\s+", " ", cleaned).strip()
    return ""


def classify_email_with_gemini(subject: str, sender: str, body_text: str) -> Dict[str, Any]:
    """Use Gemini to classify whether an email is an event/hackathon confirmation."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    prompt = f"""Classify this email. Is it a hackathon, tech event, conference, or workshop registration/confirmation/invite?
Return strict JSON with keys:
is_event_email (boolean), confidence ("high"|"medium"|"low"), title (string), date ("YYYY-MM-DD"),
start_time ("HH:MM" 24h IST), duration_minutes (number), location (string), link (string), summary (string).

From: {sender}
Subject: {subject}
Body:
{body_text[:2500]}"""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    try:
        return json.loads(response.text or "{}")
    except json.JSONDecodeError:
        return {"is_event_email": False, "confidence": "low"}


async def scan_all_inboxes(telegram_notifier=None) -> Dict[str, Any]:
    """
    Scan all connected Gmail accounts for emails from the last 1 day.
    Never modifies or deletes any emails (gmail.readonly scope only).
    """
    accounts = list_google_accounts()
    primary = get_primary_google_account()
    auto_added: List[str] = []
    uncertain: List[Dict[str, Any]] = []

    account_errors: List[Dict[str, str]] = []

    for acct in accounts:
        email_addr = acct["email"]
        try:
            service = _gmail_service(acct["refresh_token"])
            resp = (
                service.users()
                .messages()
                .list(userId="me", q="newer_than:1d", maxResults=15)
                .execute()
            )

            for msg_ref in resp.get("messages", []):
                msg_id = msg_ref["id"]
                email_key = f"{email_addr}:{msg_id}"
                if is_email_processed(email_key):
                    continue

                full_msg = (
                    service.users().messages().get(userId="me", id=msg_id, format="full").execute()
                )
                headers = {
                    h["name"].lower(): h["value"]
                    for h in full_msg.get("payload", {}).get("headers", [])
                }
                subject = headers.get("subject", "(No Subject)")
                sender = headers.get("from", "Unknown")
                body_text = _extract_text(full_msg.get("payload", {})) or full_msg.get("snippet", "")

                result = classify_email_with_gemini(subject, sender, body_text)
                mark_email_processed(email_key, email_addr)

                if not result.get("is_event_email"):
                    continue

                title = result.get("title") or subject
                date_ymd = result.get("date")
                start_time = result.get("start_time") or "10:00"
                if not date_ymd:
                    continue

                if result.get("confidence") == "high" and primary:
                    created = create_calendar_event(
                        refresh_token=primary["refresh_token"],
                        title=title,
                        date_ymd=date_ymd,
                        start_time=start_time,
                        duration_minutes=int(result.get("duration_minutes") or 120),
                        location=result.get("location", "Online"),
                        link=result.get("link", ""),
                        description=f"{result.get('summary', '')}\nSource inbox: {email_addr}",
                        auto_prefix=True,
                    )
                    if not created.get("duplicate"):
                        msg_text = f"Added: [Auto] {title} on {date_ymd} (from {email_addr})"
                        auto_added.append(msg_text)
                        if telegram_notifier:
                            await telegram_notifier.send_text(msg_text)
                else:
                    token_id = uuid.uuid4().hex[:10]
                    payload = {
                        "title": title,
                        "date": date_ymd,
                        "start_time": start_time,
                        "duration_minutes": int(result.get("duration_minutes") or 120),
                        "location": result.get("location", "Online"),
                        "link": result.get("link", ""),
                        "summary": result.get("summary", subject),
                        "account_email": email_addr,
                        "auto_prefix": True,
                    }
                    save_pending_event(token_id, payload)
                    uncertain.append({"token_id": token_id, **payload})
                    if telegram_notifier:
                        await telegram_notifier.ask_email_confirmation(token_id, payload)
        except Exception as exc:
            account_errors.append({"email": email_addr, "error": str(exc)})

    return {"auto_added": auto_added, "uncertain": uncertain, "account_errors": account_errors}
