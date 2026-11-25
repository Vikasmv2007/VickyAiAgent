import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  classifyEmailWithGemini,
  runAssistantTurn,
  searchHackathonsDigest,
} from './server/gemini.ts';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  fetchRecentGmailMessages,
  findDuplicateCalendarEvent,
  getIstOffsetDate,
  getTodayIstDate,
  listCalendarEvents,
} from './server/googleApi.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token.length > 10 ? token : null;
}

function handleApiError(res: Response, err: unknown, fallbackMsg: string) {
  const e = err as Error & { status?: number };
  const raw = e.message || fallbackMsg;
  let friendly = raw;
  let status =
    e.status === 400
      ? 400
      : e.status === 401 || e.status === 403
        ? 401
        : 500;

  if (raw.includes('503') || raw.includes('UNAVAILABLE')) {
    status = 503;
    friendly = 'AI service is experiencing a temporary spike. Please try again in a few seconds.';
  } else if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    status = 429;
    friendly =
      'Gemini API rate limit reached. Please wait ~30 seconds or check your key quota in Settings > Secrets.';
  } else if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED')) {
    status = 403;
    friendly = 'Please verify your GEMINI_API_KEY in Settings > Secrets.';
  }

  console.error(`[API Error ${status}]`, raw);
  res.status(status).json({ error: friendly });
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, timezone: 'Asia/Kolkata' });
});

app.get('/api/calendar/events', async (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in with Google to view your calendar events.' });
    return;
  }

  try {
    const range = String(req.query.range || 'upcoming');
    const today = getTodayIstDate();
    const timeMin = `${today}T00:00:00+05:30`;
    const endDay =
      range === 'today'
        ? today
        : range === 'week'
          ? getIstOffsetDate(7)
          : getIstOffsetDate(30);
    const timeMax = `${endDay}T23:59:59+05:30`;

    const events = await listCalendarEvents(token, timeMin, timeMax, 50);
    res.json({ events, timezone: 'Asia/Kolkata' });
  } catch (err) {
    handleApiError(res, err, 'Unable to load Google Calendar events.');
  }
});

app.post('/api/calendar/events', async (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in with Google to create calendar events.' });
    return;
  }

  const { title, date, startTime, durationMinutes, location, link, description, skipDuplicateCheck, autoPrefix } =
    req.body || {};

  if (!title || typeof title !== 'string' || !date || typeof date !== 'string') {
    res.status(400).json({ error: 'Event title and date (YYYY-MM-DD) are required.' });
    return;
  }

  try {
    if (!skipDuplicateCheck) {
      const duplicate = await findDuplicateCalendarEvent(token, title, date);
      if (duplicate) {
        res.status(409).json({
          error: `"${duplicate.title}" is already on your calendar for ${date}.`,
          duplicate,
        });
        return;
      }
    }

    const created = await createCalendarEvent(token, {
      title: title.trim(),
      date: date.trim(),
      startTime: typeof startTime === 'string' && startTime ? startTime : '10:00',
      durationMinutes: Number(durationMinutes) || 60,
      location: typeof location === 'string' ? location : '',
      link: typeof link === 'string' ? link : '',
      description: typeof description === 'string' ? description : '',
      autoPrefix: Boolean(autoPrefix),
    });

    res.status(201).json({ event: created });
  } catch (err) {
    handleApiError(res, err, 'Failed to create Google Calendar event.');
  }
});

app.delete('/api/calendar/events/:eventId', async (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in with Google to delete calendar events.' });
    return;
  }

  const eventId = String(req.params.eventId || '');
  if (!eventId) {
    res.status(400).json({ error: 'Missing eventId.' });
    return;
  }

  try {
    await deleteCalendarEvent(token, eventId);
    res.json({ deleted: true, eventId });
  } catch (err) {
    handleApiError(res, err, 'Failed to delete Google Calendar event.');
  }
});

app.post('/api/assistant', async (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Please say or type a message.' });
    return;
  }

  const token = extractBearerToken(req);

  try {
    const decision = await runAssistantTurn(message.trim());

    if (!decision.toolCall) {
      res.json({ action: 'reply', reply: decision.replyText });
      return;
    }

    const { name, args } = decision.toolCall;

    if (name === 'create_calendar_event') {
      const title = String(args.title || '').trim();
      const date = String(args.date || getTodayIstDate()).trim();
      const startTime = String(args.start_time || '10:00').trim();
      const durationMinutes = Number(args.duration_minutes) || 60;
      const location = String(args.location || '').trim();
      const link = String(args.link || '').trim();
      const description = String(args.description || '').trim();

      let duplicate = null;
      if (token && title) {
        try {
          duplicate = await findDuplicateCalendarEvent(token, title, date);
        } catch {
          // Non-fatal if token expired; user will be prompted when saving
        }
      }

      if (duplicate) {
        res.json({
          action: 'duplicate_found',
          reply: `"${duplicate.title}" is already on your calendar for ${date}.`,
          duplicate,
          draftEvent: {
            title,
            date,
            startTime,
            durationMinutes,
            location,
            link,
            description,
          },
        });
        return;
      }

      res.json({
        action: 'confirm_event',
        reply: `Ready to add "${title}" on ${date} at ${startTime} IST. Confirm or edit below.`,
        draftEvent: {
          title,
          date,
          startTime,
          durationMinutes,
          location,
          link,
          description,
        },
      });
      return;
    }

    if (name === 'list_events') {
      if (!token) {
        res.json({
          action: 'needs_auth',
          reply: 'Connect your Google account so I can check your calendar events.',
        });
        return;
      }
      const range = String(args.range || 'week');
      const today = getTodayIstDate();
      const timeMin = `${today}T00:00:00+05:30`;
      const endDay =
        range === 'today'
          ? today
          : range === 'week'
            ? getIstOffsetDate(7)
            : getIstOffsetDate(30);
      const events = await listCalendarEvents(token, timeMin, `${endDay}T23:59:59+05:30`, 30);

      res.json({
        action: 'list_events',
        range,
        events,
        reply:
          events.length === 0
            ? `You have no events scheduled for ${range === 'today' ? 'today' : 'this period'}.`
            : `Found ${events.length} event${events.length === 1 ? '' : 's'} on your calendar.`,
      });
      return;
    }

    if (name === 'delete_event') {
      if (!token) {
        res.json({
          action: 'needs_auth',
          reply: 'Connect your Google account before deleting events.',
        });
        return;
      }
      const query = String(args.event_title || '').toLowerCase();
      const today = getTodayIstDate();
      const events = await listCalendarEvents(
        token,
        `${today}T00:00:00+05:30`,
        `${getIstOffsetDate(90)}T23:59:59+05:30`,
        50
      );
      const matched = events.find((ev) => ev.title.toLowerCase().includes(query));
      if (!matched) {
        res.json({
          action: 'reply',
          reply: `I could not find an upcoming event matching "${args.event_title}".`,
        });
        return;
      }
      res.json({
        action: 'confirm_delete',
        reply: `Confirm if you want me to delete "${matched.title}".`,
        targetEvent: matched,
      });
      return;
    }

    if (name === 'search_hackathons') {
      const items = await searchHackathonsDigest(String(args.query || ''));
      res.json({
        action: 'hackathon_digest',
        items,
        reply:
          items.length > 0
            ? `Found ${items.length} upcoming tech events and hackathons.`
            : 'No new hackathons matched right now.',
      });
      return;
    }

    if (name === 'scan_emails') {
      res.json({
        action: 'trigger_email_scan',
        reply: 'Scanning your connected Gmail accounts for event confirmations...',
      });
      return;
    }

    res.json({ action: 'reply', reply: decision.replyText || 'Done.' });
  } catch (err) {
    handleApiError(res, err, 'Assistant request failed.');
  }
});

app.post('/api/gmail/scan', async (req: Request, res: Response) => {
  const {
    accounts,
    primaryCalendarToken,
    processedIds,
  } = (req.body || {}) as {
    accounts?: Array<{ email: string; accessToken: string }>;
    primaryCalendarToken?: string;
    processedIds?: string[];
  };

  if (!Array.isArray(accounts) || accounts.length === 0) {
    res.status(400).json({ error: 'Connect at least one Gmail account first.' });
    return;
  }

  const processedSet = new Set<string>(Array.isArray(processedIds) ? processedIds : []);
  const newlyProcessedIds: string[] = [];
  const autoAdded: Array<{
    accountEmail: string;
    event: Awaited<ReturnType<typeof createCalendarEvent>>;
    summary: string;
  }> = [];
  const duplicates: Array<{ accountEmail: string; title: string; date: string }> = [];
  const needsConfirmation: Array<{
    id: string;
    accountEmail: string;
    subject: string;
    from: string;
    title: string;
    date: string;
    startTime: string;
    durationMinutes: number;
    location: string;
    link: string;
    summary: string;
  }> = [];
  const accountErrors: Array<{ email: string; error: string }> = [];

  for (const acct of accounts) {
    if (!acct?.email || !acct?.accessToken) continue;
    try {
      const messages = await fetchRecentGmailMessages(
        acct.accessToken,
        acct.email,
        processedSet,
        10
      );

      for (const msg of messages) {
        const key = `${acct.email}:${msg.id}`;
        newlyProcessedIds.push(key);
        processedSet.add(key);

        const classified = await classifyEmailWithGemini(msg);
        if (!classified.isEventEmail) continue;

        if (classified.confidence === 'high' && primaryCalendarToken) {
          const dup = await findDuplicateCalendarEvent(
            primaryCalendarToken,
            classified.title,
            classified.date
          );
          if (dup) {
            duplicates.push({
              accountEmail: acct.email,
              title: classified.title,
              date: classified.date,
            });
            continue;
          }
          const created = await createCalendarEvent(primaryCalendarToken, {
            title: classified.title,
            date: classified.date,
            startTime: classified.startTime,
            durationMinutes: classified.durationMinutes,
            location: classified.location,
            link: classified.link,
            description: `${classified.summary}\nDetected from Gmail: ${acct.email}`,
            autoPrefix: true,
          });
          autoAdded.push({
            accountEmail: acct.email,
            event: created,
            summary: `Added: ${created.title} on ${classified.date} (from ${acct.email})`,
          });
        } else {
          needsConfirmation.push({
            id: key,
            accountEmail: acct.email,
            subject: msg.subject,
            from: msg.from,
            title: classified.title,
            date: classified.date,
            startTime: classified.startTime,
            durationMinutes: classified.durationMinutes,
            location: classified.location,
            link: classified.link,
            summary: classified.summary,
          });
        }
      }
    } catch (err) {
      accountErrors.push({
        email: acct.email,
        error: err instanceof Error ? err.message : 'Scan failed for this account.',
      });
    }
  }

  res.json({
    newlyProcessedIds,
    autoAdded,
    duplicates,
    needsConfirmation,
    accountErrors,
  });
});

app.post('/api/hackathons/digest', async (req: Request, res: Response) => {
  const { query, seenKeys } = (req.body || {}) as {
    query?: string;
    seenKeys?: string[];
  };
  try {
    const items = await searchHackathonsDigest(query, Array.isArray(seenKeys) ? seenKeys : []);
    res.json({ items, generatedAtIst: new Date().toISOString() });
  } catch (err) {
    handleApiError(res, err, 'Failed to fetch hackathon digest.');
  }
});

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use((err: unknown, req: Request, res: Response, next: express.NextFunction) => {
  if (req.originalUrl.startsWith('/api')) {
    handleApiError(res, err, 'Internal server error.');
    return;
  }
  next(err);
});

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Vicky server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
