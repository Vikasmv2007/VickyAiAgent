"""
calendar_tools.py - Google Calendar API helpers for Vicky.
Always uses Asia/Kolkata (IST) timezone, checks for duplicates by title + date,
and adds 1-day (1440 min) and 1-hour (60 min) popup reminders.
"""

import os
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import pytz
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

IST = pytz.timezone("Asia/Kolkata")


def _build_credentials(refresh_token: str) -> Credentials:
    """Create Google OAuth credentials from a stored refresh token."""
    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.getenv("GOOGLE_CLIENT_ID"),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    )


def _calendar_service(refresh_token: str):
    creds = _build_credentials(refresh_token)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def _normalize_title(text: str) -> str:
    cleaned = re.sub(r"^\[Auto\]\s*", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"[^a-z0-9\s]", " ", cleaned.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _titles_match(a: str, b: str) -> bool:
    na, nb = _normalize_title(a), _normalize_title(b)
    if not na or not nb:
        return False
    return na == nb or (len(na) > 5 and len(nb) > 5 and (na in nb or nb in na))


def _safe_parse_date(date_ymd: str) -> datetime:
    """Parse YYYY-MM-DD safely, falling back to today's IST date if malformed."""
    clean = (date_ymd or "").strip()[:10]
    try:
        return IST.localize(datetime.strptime(clean, "%Y-%m-%d"))
    except ValueError:
        today_str = datetime.now(IST).strftime("%Y-%m-%d")
        return IST.localize(datetime.strptime(today_str, "%Y-%m-%d"))


def _safe_parse_time(start_time: str) -> tuple[int, int]:
    """Extract (hour, minute) safely from HH:MM or HH:MM:SS strings."""
    match = re.match(r"^\s*(\d{1,2}):(\d{2})", start_time or "10:00")
    if not match:
        return 10, 0
    hour = min(23, max(0, int(match.group(1))))
    minute = min(59, max(0, int(match.group(2))))
    return hour, minute


def find_duplicate_event(refresh_token: str, title: str, date_ymd: str) -> Optional[Dict[str, Any]]:
    """Check if an event with the same title already exists on date_ymd (IST)."""
    service = _calendar_service(refresh_token)
    day_start = _safe_parse_date(date_ymd)
    day_end = day_start + timedelta(hours=23, minutes=59, seconds=59)

    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=day_start.isoformat(),
            timeMax=day_end.isoformat(),
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )

    for item in result.get("items", []):
        if _titles_match(item.get("summary", ""), title):
            return {
                "id": item.get("id"),
                "title": item.get("summary"),
                "start": item.get("start", {}).get("dateTime") or item.get("start", {}).get("date"),
            }
    return None


def create_calendar_event(
    refresh_token: str,
    title: str,
    date_ymd: str,
    start_time: str = "10:00",
    duration_minutes: int = 60,
    location: str = "",
    link: str = "",
    description: str = "",
    auto_prefix: bool = False,
    skip_duplicate_check: bool = False,
) -> Dict[str, Any]:
    """
    Create an event in Google Calendar in Asia/Kolkata with 1-day & 1-hour reminders.
    Returns {"duplicate": True, "existing": ...} if a duplicate exists.
    """
    if not skip_duplicate_check:
        dup = find_duplicate_event(refresh_token, title, date_ymd)
        if dup:
            return {"duplicate": True, "existing": dup}

    summary = f"[Auto] {title}" if (auto_prefix and not title.startswith("[Auto]")) else title

    day_dt = _safe_parse_date(date_ymd)
    hour, minute = _safe_parse_time(start_time)
    start_dt = day_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
    end_dt = start_dt + timedelta(minutes=max(15, int(duration_minutes or 60)))

    desc_lines = [d for d in [description.strip()] if d]
    if link:
        desc_lines.append(f"Event Link: {link}")
    desc_lines.append("Added via Vicky AI Assistant")

    event_body: Dict[str, Any] = {
        "summary": summary,
        "description": "\n\n".join(desc_lines),
        "start": {"dateTime": start_dt.isoformat(), "timeZone": "Asia/Kolkata"},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": "Asia/Kolkata"},
        "reminders": {
            "useDefault": False,
            "overrides": [
                {"method": "popup", "minutes": 1440},  # 1 day before
                {"method": "popup", "minutes": 60},    # 1 hour before
            ],
        },
    }
    if location and location.strip():
        event_body["location"] = location.strip()

    service = _calendar_service(refresh_token)
    created = service.events().insert(calendarId="primary", body=event_body).execute()
    return {
        "duplicate": False,
        "event": {
            "id": created.get("id"),
            "title": created.get("summary"),
            "start": created.get("start", {}).get("dateTime"),
            "end": created.get("end", {}).get("dateTime"),
            "location": created.get("location", ""),
            "htmlLink": created.get("htmlLink", ""),
        },
    }


def list_events(refresh_token: str, days_ahead: int = 7) -> List[Dict[str, Any]]:
    """List upcoming events from primary Google Calendar starting today (IST)."""
    service = _calendar_service(refresh_token)
    now_ist = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
    end_ist = now_ist + timedelta(days=days_ahead, hours=23, minutes=59)

    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=now_ist.isoformat(),
            timeMax=end_ist.isoformat(),
            singleEvents=True,
            orderBy="startTime",
            maxResults=40,
        )
        .execute()
    )

    events = []
    for item in result.get("items", []):
        events.append(
            {
                "id": item.get("id"),
                "title": item.get("summary", "(Untitled)"),
                "start": item.get("start", {}).get("dateTime") or item.get("start", {}).get("date"),
                "end": item.get("end", {}).get("dateTime") or item.get("end", {}).get("date"),
                "location": item.get("location", ""),
                "htmlLink": item.get("htmlLink", ""),
            }
        )
    return events


def delete_event(refresh_token: str, event_id: str) -> bool:
    """Delete an event from Google Calendar by ID."""
    service = _calendar_service(refresh_token)
    service.events().delete(calendarId="primary", eventId=event_id).execute()
    return True
