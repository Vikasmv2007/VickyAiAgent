"""
scheduler.py - APScheduler jobs running in Asia/Kolkata timezone:
  1. Every day at 8:00 AM IST -> search hackathons & send digest to Telegram
  2. Every 30 minutes -> scan all connected Gmail accounts
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler
import pytz

from agent import search_hackathons
from gmail_tools import scan_all_inboxes
from telegram_bot import TelegramNotifier

IST = pytz.timezone("Asia/Kolkata")


def start_scheduler(telegram_app=None) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=IST)
    notifier = TelegramNotifier(telegram_app) if telegram_app else None

    async def daily_hackathon_job():
        items = search_hackathons()
        if notifier and items:
            await notifier.send_hackathon_digest(items)

    async def email_scan_job():
        await scan_all_inboxes(telegram_notifier=notifier)

    # Daily 8:00 AM IST morning digest
    scheduler.add_job(daily_hackathon_job, trigger="cron", hour=8, minute=0, id="morning_digest")
    # Multi-account Gmail scan every 30 minutes
    scheduler.add_job(email_scan_job, trigger="interval", minutes=30, id="gmail_scanner")

    scheduler.start()
    return scheduler
