export interface CalendarEventInput {
  title: string;
  date: string; // YYYY-MM-DD in Asia/Kolkata
  startTime: string; // HH:MM (24-hour) in Asia/Kolkata
  durationMinutes?: number;
  location?: string;
  link?: string;
  description?: string;
  autoPrefix?: boolean;
}

export interface CalendarEventRecord {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  isAllDay?: boolean;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  accountEmail: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string;
}

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

async function safeParseJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error(`${context} returned an unexpected HTML response (HTTP ${res.status}).`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${context} returned invalid JSON (HTTP ${res.status}).`);
  }
}

/**
 * Formats YYYY-MM-DD + HH:MM in Asia/Kolkata (+05:30) and computes end ISO string.
 */
export function buildIstDateTimes(
  dateStr: string,
  startTime: string,
  durationMinutes = 60
): { startIso: string; endIso: string } {
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? dateStr
    : getTodayIstDate();
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(startTime || '10:00');
  const hour = timeMatch ? Math.min(23, Math.max(0, Number(timeMatch[1]))) : 10;
  const minute = timeMatch ? Math.min(59, Math.max(0, Number(timeMatch[2]))) : 0;
  const safeDuration = Math.max(15, Math.min(24 * 60 * 7, Number(durationMinutes) || 60));

  const startIso = `${cleanDate}T${pad2(hour)}:${pad2(minute)}:00+05:30`;
  const startMs = new Date(startIso).getTime();
  const endMs = startMs + safeDuration * 60 * 1000;

  // Format endMs back into +05:30 offset string
  const istEnd = new Date(endMs + 5.5 * 60 * 60 * 1000);
  const ey = istEnd.getUTCFullYear();
  const em = pad2(istEnd.getUTCMonth() + 1);
  const ed = pad2(istEnd.getUTCDate());
  const eh = pad2(istEnd.getUTCHours());
  const emin = pad2(istEnd.getUTCMinutes());
  const endIso = `${ey}-${em}-${ed}T${eh}:${emin}:00+05:30`;

  return { startIso, endIso };
}

export function getTodayIstDate(): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${nowIst.getUTCFullYear()}-${pad2(nowIst.getUTCMonth() + 1)}-${pad2(nowIst.getUTCDate())}`;
}

export function getIstOffsetDate(daysAhead: number): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000 + daysAhead * 86400 * 1000);
  return `${nowIst.getUTCFullYear()}-${pad2(nowIst.getUTCMonth() + 1)}-${pad2(nowIst.getUTCDate())}`;
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^\[auto\]\s*/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSameEventTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 5 && nb.length > 5 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  return false;
}

export async function listCalendarEvents(
  accessToken: string,
  timeMinIso: string,
  timeMaxIso: string,
  maxResults = 40
): Promise<CalendarEventRecord[]> {
  const url = new URL(CALENDAR_BASE);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeMin', timeMinIso);
  url.searchParams.set('timeMax', timeMaxIso);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('timeZone', 'Asia/Kolkata');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    const error = new Error(`Google Calendar API error (${res.status}): ${errText}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }

  const data = await safeParseJson<{
    items?: Array<{
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
      description?: string;
      htmlLink?: string;
    }>;
  }>(res, 'Google Calendar API');

  return (data.items || []).map((item) => ({
    id: item.id,
    title: item.summary || '(Untitled Event)',
    start: item.start?.dateTime || item.start?.date || '',
    end: item.end?.dateTime || item.end?.date || '',
    location: item.location || '',
    description: item.description || '',
    htmlLink: item.htmlLink || '',
    isAllDay: Boolean(item.start?.date && !item.start?.dateTime),
  }));
}

export async function findDuplicateCalendarEvent(
  accessToken: string,
  title: string,
  dateYmd: string
): Promise<CalendarEventRecord | null> {
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(dateYmd) ? dateYmd : getTodayIstDate();
  const dayStart = `${cleanDate}T00:00:00+05:30`;
  const dayEnd = `${cleanDate}T23:59:59+05:30`;

  const events = await listCalendarEvents(accessToken, dayStart, dayEnd, 30);
  return events.find((ev) => isSameEventTitle(ev.title, title)) || null;
}

export async function createCalendarEvent(
  accessToken: string,
  input: CalendarEventInput
): Promise<CalendarEventRecord> {
  const summary =
    input.autoPrefix && !input.title.startsWith('[Auto]')
      ? `[Auto] ${input.title}`
      : input.title;

  const { startIso, endIso } = buildIstDateTimes(
    input.date,
    input.startTime,
    input.durationMinutes
  );

  const descriptionParts: string[] = [];
  if (input.description) descriptionParts.push(input.description.trim());
  if (input.link && /^https?:\/\//i.test(input.link.trim())) {
    descriptionParts.push(`Event Link: ${input.link.trim()}`);
  }
  descriptionParts.push('Added via Vicky AI Assistant (Asia/Kolkata)');

  const body = {
    summary,
    location: input.location || undefined,
    description: descriptionParts.join('\n\n'),
    start: {
      dateTime: startIso,
      timeZone: 'Asia/Kolkata',
    },
    end: {
      dateTime: endIso,
      timeZone: 'Asia/Kolkata',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 1440 }, // 1 day before
        { method: 'popup', minutes: 60 }, // 1 hour before
      ],
    },
  };

  const res = await fetch(CALENDAR_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    const error = new Error(`Failed to create event (${res.status}): ${errText}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }

  const created = await safeParseJson<{
    id: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    description?: string;
    htmlLink?: string;
  }>(res, 'Google Calendar create');

  return {
    id: created.id,
    title: created.summary || summary,
    start: created.start?.dateTime || startIso,
    end: created.end?.dateTime || endIso,
    location: created.location || input.location || '',
    description: created.description || '',
    htmlLink: created.htmlLink || '',
  };
}

export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<void> {
  const safeId = encodeURIComponent(eventId);
  const res = await fetch(`${CALENDAR_BASE}/${safeId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok && res.status !== 204) {
    const errText = await res.text();
    const error = new Error(`Failed to delete event (${res.status}): ${errText}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
}

function decodeBase64Url(str: string): string {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

function extractPlainText(payload?: GmailPayloadPart): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  }
  return '';
}

export async function fetchRecentGmailMessages(
  accessToken: string,
  accountEmail: string,
  alreadyProcessedIds: Set<string>,
  maxMessages = 12
): Promise<GmailMessageSummary[]> {
  const listUrl = new URL(GMAIL_BASE);
  listUrl.searchParams.set('q', 'newer_than:1d');
  listUrl.searchParams.set('maxResults', String(maxMessages));

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    const errText = await listRes.text();
    const error = new Error(`Gmail API error (${listRes.status}): ${errText}`) as Error & {
      status?: number;
    };
    error.status = listRes.status;
    throw error;
  }

  const listData = await safeParseJson<{
    messages?: Array<{ id: string; threadId: string }>;
  }>(listRes, 'Gmail list API');

  const candidates = (listData.messages || []).filter(
    (m) => !alreadyProcessedIds.has(`${accountEmail}:${m.id}`)
  );

  const results: GmailMessageSummary[] = [];
  for (const msg of candidates.slice(0, maxMessages)) {
    const msgRes = await fetch(`${GMAIL_BASE}/${encodeURIComponent(msg.id)}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!msgRes.ok) continue;

    const full = await safeParseJson<{
      id: string;
      threadId: string;
      snippet?: string;
      payload?: GmailPayloadPart & {
        headers?: Array<{ name: string; value: string }>;
      };
    }>(msgRes, 'Gmail message API');

    const headers = full.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const bodyText = extractPlainText(full.payload).slice(0, 2500);
    results.push({
      id: full.id,
      threadId: full.threadId,
      accountEmail,
      subject: getHeader('Subject') || '(No Subject)',
      from: getHeader('From') || 'Unknown Sender',
      date: getHeader('Date') || '',
      snippet: full.snippet || '',
      bodyText: bodyText || full.snippet || '',
    });
  }

  return results;
}
