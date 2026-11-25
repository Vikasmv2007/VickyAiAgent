"""
telegram_bot.py - Telegram bot interface for Vicky using python-telegram-bot.
Supports:
  - /today, /week, /add <text>, /hackathons, /accounts
  - Plain text messages (treated like voice input)
  - Voice notes (transcribed with Gemini audio understanding)
  - Inline buttons: "Add to calendar", "Ignore", and Gmail Yes/No confirmations
"""

import os
import tempfile
import uuid
from typing import Any, Dict, List

from google import genai
from google.genai import types
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from agent import run_agent, search_hackathons
from calendar_tools import create_calendar_event, list_events
from db import (
    get_primary_google_account,
    list_google_accounts,
    pop_pending_event,
    save_pending_event,
)


class TelegramNotifier:
    """Helper used by APScheduler and Gmail scanner to push messages to your Telegram chat."""

    def __init__(self, app: Application):
        self.app = app
        self.chat_id = os.getenv("TELEGRAM_CHAT_ID")

    async def send_text(self, text: str) -> None:
        if self.chat_id:
            await self.app.bot.send_message(chat_id=self.chat_id, text=text)

    async def ask_email_confirmation(self, token_id: str, payload: Dict[str, Any]) -> None:
        if not self.chat_id:
            return
        keyboard = InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("Yes, add to calendar", callback_data=f"add:{token_id}"),
                    InlineKeyboardButton("No, ignore", callback_data=f"ignore:{token_id}"),
                ]
            ]
        )
        msg = (
            f"Found possible event email in {payload['account_email']}:\n"
            f"• {payload['title']}\n"
            f"• {payload['date']} at {payload['start_time']} IST\n"
            f"Add this to your calendar?"
        )
        await self.app.bot.send_message(chat_id=self.chat_id, text=msg, reply_markup=keyboard)

    async def send_hackathon_digest(self, items: List[Dict[str, Any]]) -> None:
        if not self.chat_id or not items:
            return
        await self.app.bot.send_message(
            chat_id=self.chat_id,
            text="Morning Hackathon & Tech Event Digest (8:00 AM IST):",
        )
        for item in items[:5]:
            token_id = uuid.uuid4().hex[:10]
            save_pending_event(
                token_id,
                {
                    "title": item.get("name", "Hackathon"),
                    "date": item.get("event_date"),
                    "start_time": "10:00",
                    "duration_minutes": 180,
                    "location": item.get("location", "Online"),
                    "link": item.get("link", ""),
                    "summary": item.get("description", ""),
                    "auto_prefix": False,
                },
            )
            keyboard = InlineKeyboardMarkup(
                [
                    [
                        InlineKeyboardButton("Add to calendar", callback_data=f"add:{token_id}"),
                        InlineKeyboardButton("Ignore", callback_data=f"ignore:{token_id}"),
                    ]
                ]
            )
            msg = (
                f"{item.get('name')}\n"
                f"Date: {item.get('event_date')} | Deadline: {item.get('deadline')}\n"
                f"{item.get('description')}\n"
                f"{item.get('link')}"
            )
            await self.app.bot.send_message(chat_id=self.chat_id, text=msg, reply_markup=keyboard)


async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    primary = get_primary_google_account()
    if not primary:
        await update.message.reply_text("Connect a Google account in Vicky first.")
        return
    events = list_events(primary["refresh_token"], days_ahead=1)
    if not events:
        await update.message.reply_text("You have no events scheduled for today.")
        return
    lines = [f"• {e['title']} ({e['start']})" for e in events]
    await update.message.reply_text("Today's Events:\n" + "\n".join(lines))


async def cmd_week(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    primary = get_primary_google_account()
    if not primary:
        await update.message.reply_text("Connect a Google account in Vicky first.")
        return
    events = list_events(primary["refresh_token"], days_ahead=7)
    if not events:
        await update.message.reply_text("Your next 7 days are completely free.")
        return
    lines = [f"• {e['title']} ({e['start']})" for e in events]
    await update.message.reply_text("This Week's Events:\n" + "\n".join(lines))


async def cmd_accounts(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    accts = list_google_accounts()
    if not accts:
        await update.message.reply_text("No Google accounts connected yet.")
        return
    lines = [f"• {a['email']} ({'Primary' if a['is_primary'] else 'Gmail'})" for a in accts]
    await update.message.reply_text("Connected Accounts:\n" + "\n".join(lines))


async def cmd_hackathons(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    items = search_hackathons()
    notifier = TelegramNotifier(context.application)
    if not items:
        await update.message.reply_text("No new hackathons found right now.")
        return
    await notifier.send_hackathon_digest(items)


async def _handle_natural_text(update: Update, text: str) -> None:
    if not update.message:
        return
    result = run_agent(text, auto_commit_calendar=True)
    if result.get("action") == "list_events":
        events = result.get("events", [])
        if not events:
            await update.message.reply_text("No matching events found.")
        else:
            lines = [f"• {e['title']} ({e['start']})" for e in events]
            await update.message.reply_text("\n".join(lines))
        return
    await update.message.reply_text(result.get("reply", "Done."))


async def cmd_add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    text = " ".join(context.args or [])
    if not text:
        await update.message.reply_text("Usage: /add Smart India Hackathon on 12 Dec at 10 AM")
        return
    await _handle_natural_text(update, f"Add {text}")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message and update.message.text:
        await _handle_natural_text(update, update.message.text)


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Download Telegram voice note (.ogg), transcribe with Gemini, and run the assistant."""
    if not update.message or not update.message.voice:
        return
    tg_file = await context.bot.get_file(update.message.voice.file_id)
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=True) as tmp:
        await tg_file.download_to_drive(tmp.name)
        with open(tmp.name, "rb") as f:
            audio_bytes = f.read()

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            types.Part.from_bytes(data=audio_bytes, mime_type="audio/ogg"),
            "Transcribe this voice message accurately in plain text.",
        ],
    )
    transcript = (resp.text or "").strip()
    if not transcript:
        await update.message.reply_text("Sorry, I could not hear that voice note clearly.")
        return
    await update.message.reply_text(f"Heard: \"{transcript}\"")
    await _handle_natural_text(update, transcript)


async def handle_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query:
        return
    await query.answer()
    if not query.data or ":" not in query.data:
        return
    action, token_id = query.data.split(":", 1)
    payload = pop_pending_event(token_id)

    if action == "ignore" or not payload:
        await query.edit_message_text("Ignored.")
        return

    primary = get_primary_google_account()
    if not primary:
        await query.edit_message_text("Connect a Google account first.")
        return

    title = payload.get("title") or "Untitled Event"
    date_ymd = payload.get("date") or ""
    res = create_calendar_event(
        refresh_token=primary["refresh_token"],
        title=title,
        date_ymd=date_ymd,
        start_time=payload.get("start_time", "10:00"),
        duration_minutes=int(payload.get("duration_minutes") or 120),
        location=payload.get("location", "Online"),
        link=payload.get("link", ""),
        description=payload.get("summary", ""),
        auto_prefix=bool(payload.get("auto_prefix", False)),
    )
    if res.get("duplicate"):
        await query.edit_message_text(f"Already on calendar: {title} ({date_ymd})")
    else:
        await query.edit_message_text(f"Added to Google Calendar: {title} on {date_ymd}")


def build_telegram_app() -> Application | None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        return None
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(CommandHandler("week", cmd_week))
    app.add_handler(CommandHandler("add", cmd_add))
    app.add_handler(CommandHandler("hackathons", cmd_hackathons))
    app.add_handler(CommandHandler("accounts", cmd_accounts))
    app.add_handler(CallbackQueryHandler(handle_button))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    return app
