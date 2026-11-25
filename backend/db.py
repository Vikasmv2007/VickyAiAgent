"""
db.py - Simple SQLite helper for Vicky.
Stores:
  1. Connected Google accounts and their OAuth refresh tokens
  2. Processed Gmail message IDs (so no email is scanned twice)
  3. Seen hackathon titles/links (so morning digests never repeat)
  4. Pending confirmations (for Telegram Yes/No or Add-to-Calendar buttons)
"""

import json
import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

DB_PATH = os.getenv("SQLITE_DB_PATH", "vicky.db")


@contextmanager
def get_conn():
    """Open a SQLite connection and always close it cleanly."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if they do not exist yet."""
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS google_accounts (
                email TEXT PRIMARY KEY,
                display_name TEXT,
                refresh_token TEXT NOT NULL,
                is_primary INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS processed_emails (
                email_key TEXT PRIMARY KEY,
                account_email TEXT NOT NULL,
                processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seen_hackathons (
                dedup_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                link TEXT,
                seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_events (
                token_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


def save_google_account(email: str, display_name: str, refresh_token: str, is_primary: bool = False) -> None:
    """Save or update a Google account's refresh token."""
    with get_conn() as conn:
        existing_primary = conn.execute(
            "SELECT email FROM google_accounts WHERE is_primary = 1"
        ).fetchone()

        make_primary = 1 if (is_primary or existing_primary is None) else 0
        if make_primary == 1:
            conn.execute("UPDATE google_accounts SET is_primary = 0")

        conn.execute(
            """
            INSERT INTO google_accounts (email, display_name, refresh_token, is_primary)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                display_name = excluded.display_name,
                refresh_token = COALESCE(NULLIF(excluded.refresh_token, ''), google_accounts.refresh_token),
                is_primary = CASE WHEN excluded.is_primary = 1 THEN 1 ELSE google_accounts.is_primary END
            """,
            (email, display_name, refresh_token, make_primary),
        )


def list_google_accounts() -> List[Dict[str, Any]]:
    """Return all connected Google accounts."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT email, display_name, refresh_token, is_primary, created_at FROM google_accounts ORDER BY is_primary DESC, created_at ASC"
        ).fetchall()
        return [dict(row) for row in rows]


def get_primary_google_account() -> Optional[Dict[str, Any]]:
    """Return the primary Google account used for Calendar events."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT email, display_name, refresh_token, is_primary FROM google_accounts WHERE is_primary = 1 LIMIT 1"
        ).fetchone()
        if row:
            return dict(row)
        fallback = conn.execute(
            "SELECT email, display_name, refresh_token, is_primary FROM google_accounts LIMIT 1"
        ).fetchone()
        return dict(fallback) if fallback else None


def remove_google_account(email: str) -> None:
    """Disconnect a Google account and promote another account if primary was removed."""
    with get_conn() as conn:
        conn.execute("DELETE FROM google_accounts WHERE email = ?", (email,))
        remaining_primary = conn.execute(
            "SELECT email FROM google_accounts WHERE is_primary = 1 LIMIT 1"
        ).fetchone()
        if not remaining_primary:
            next_acct = conn.execute(
                "SELECT email FROM google_accounts ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            if next_acct:
                conn.execute(
                    "UPDATE google_accounts SET is_primary = 1 WHERE email = ?",
                    (next_acct["email"],),
                )


def is_email_processed(email_key: str) -> bool:
    """Check if an email ID has already been scanned."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM processed_emails WHERE email_key = ?", (email_key,)
        ).fetchone()
        return row is not None


def mark_email_processed(email_key: str, account_email: str) -> None:
    """Mark an email ID as processed so it is never scanned twice."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO processed_emails (email_key, account_email) VALUES (?, ?)",
            (email_key, account_email),
        )


def is_hackathon_seen(dedup_key: str) -> bool:
    """Check whether we already sent this hackathon in a previous digest."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM seen_hackathons WHERE dedup_key = ?", (dedup_key,)
        ).fetchone()
        return row is not None


def mark_hackathon_seen(dedup_key: str, name: str, link: str) -> None:
    """Record a hackathon so future digests skip it."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO seen_hackathons (dedup_key, name, link) VALUES (?, ?, ?)",
            (dedup_key, name, link),
        )


def save_pending_event(token_id: str, payload: Dict[str, Any]) -> None:
    """Store an event payload temporarily for Telegram inline button callbacks."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO pending_events (token_id, payload_json) VALUES (?, ?)",
            (token_id, json.dumps(payload)),
        )


def pop_pending_event(token_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve and remove a pending event payload by its short token ID."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload_json FROM pending_events WHERE token_id = ?", (token_id,)
        ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM pending_events WHERE token_id = ?", (token_id,))
        return json.loads(row["payload_json"])
