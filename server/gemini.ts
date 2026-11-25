import { FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { getTodayIstDate, GmailMessageSummary } from './googleApi.ts';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getThinkingConfig(model: string) {
  return model === 'gemini-4-hydrogen' ? { thinkingLevel: ThinkingLevel.LOW } : undefined;
}

/**
 * Tries gemini-4-hydrogen first; on 429/503 immediately falls back to gemini-3.1-flash-lite
 * (separate quota pool, minimal thinking overhead) instead of hammering a rate-limited model.
 */
async function withModelFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  const models = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastErr: unknown;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fn(model);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isUnavailable = msg.includes('503') || msg.includes('UNAVAILABLE');

        // On rate limit, do not retry the same model—switch immediately to fallback model
        if (isRateLimit) {
          break;
        }
        // On transient 503, retry once briefly then switch model
        if (isUnavailable && attempt === 0) {
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        if (isUnavailable) {
          break;
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

function getCurrentIstContext(): string {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${istFormatter.format(now)} (YYYY-MM-DD today in IST: ${getTodayIstDate()})`;
}

export const ASSISTANT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'create_calendar_event',
    description:
      'Extract details to schedule or add an event/hackathon to Google Calendar in Asia/Kolkata timezone.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Clear event or hackathon title.' },
        date: {
          type: Type.STRING,
          description: 'Event date in YYYY-MM-DD format (Asia/Kolkata).',
        },
        start_time: {
          type: Type.STRING,
          description: 'Start time in 24-hour HH:MM format (default 10:00 if unspecified).',
        },
        duration_minutes: {
          type: Type.NUMBER,
          description: 'Duration in minutes (default 60 for meetings, 180 for hackathons).',
        },
        location: { type: Type.STRING, description: 'Venue, city, or Online.' },
        link: { type: Type.STRING, description: 'Registration or meeting URL if provided.' },
        description: { type: Type.STRING, description: 'Short summary or notes.' },
      },
      required: ['title', 'date', 'start_time'],
    },
  },
  {
    name: 'list_events',
    description: 'List events from Google Calendar for today, this week, or upcoming days.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        range: {
          type: Type.STRING,
          description: 'One of: today, week, upcoming',
        },
      },
      required: ['range'],
    },
  },
  {
    name: 'delete_event',
    description: 'Request deletion of a specific event from Google Calendar.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        event_title: { type: Type.STRING, description: 'Title or keywords of event to delete.' },
        date: { type: Type.STRING, description: 'Optional YYYY-MM-DD date of the event.' },
      },
      required: ['event_title'],
    },
  },
  {
    name: 'search_hackathons',
    description:
      'Search the web for upcoming hackathons, tech events, and open-source programs in India and online.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search query (e.g. India hackathons Devfolio Unstop MLH upcoming).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'scan_emails',
    description: 'Scan connected Gmail inboxes for recent event or hackathon confirmations.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        account_email: {
          type: Type.STRING,
          description: 'Optional specific email address, or "all" for all connected accounts.',
        },
      },
      required: [],
    },
  },
];

export interface AssistantToolDecision {
  replyText: string;
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
  };
}

export async function runAssistantTurn(userPrompt: string): Promise<AssistantToolDecision> {
  const ai = getAiClient();
  const istNow = getCurrentIstContext();

  const response = await withModelFallback((model) =>
    ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        thinkingConfig: getThinkingConfig(model),
        systemInstruction: `You are Vicky, a concise, friendly personal AI assistant for events and hackathons.
Current local date & time in India: ${istNow}.
Always interpret relative dates ("today", "tomorrow", "next Saturday", "12 Dec") in Asia/Kolkata (IST) timezone.
When the user wants to add/create/schedule an event or hackathon, call create_calendar_event with clean extracted fields.
When the user asks what events they have today, this week, or coming up, call list_events.
When the user wants to remove or cancel an event, call delete_event.
When the user asks to find hackathons or tech events, call search_hackathons.
When the user asks to check or scan their Gmail/emails, call scan_emails.
Keep any conversational reply brief and clear.`,
        tools: [{ functionDeclarations: ASSISTANT_TOOLS }],
      },
    })
  );

  const firstCall = response.functionCalls?.[0];
  if (firstCall && firstCall.name) {
    return {
      replyText: response.text || '',
      toolCall: {
        name: firstCall.name,
        args: (firstCall.args as Record<string, unknown>) || {},
      },
    };
  }

  return {
    replyText:
      response.text ||
      'Tell me an event to add (for example, "Add Smart India Hackathon on 12 Dec at 10 AM") or ask about your schedule.',
  };
}

export interface EmailClassification {
  isEventEmail: boolean;
  confidence: 'high' | 'medium' | 'low';
  title: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  location: string;
  link: string;
  summary: string;
}

export async function classifyEmailWithGemini(
  email: GmailMessageSummary
): Promise<EmailClassification> {
  const ai = getAiClient();
  const istNow = getCurrentIstContext();

  const prompt = `Analyze this email and decide if it is a hackathon, tech event, workshop, webinar, or conference registration, confirmation, ticket, or invite.
Current IST date/time: ${istNow}.

From: ${email.from}
Subject: ${email.subject}
Date Header: ${email.date}
Body:
${email.bodyText}`;

  const response = await withModelFallback((model) =>
    ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        thinkingConfig: getThinkingConfig(model),
        systemInstruction:
          'You accurately classify whether an email is an event/hackathon registration, confirmation, or invite. Ignore newsletters, promotional spam, OTPs, receipts unrelated to live events, or general digests unless it is a specific confirmed registration or personal invite. Extract dates and times in Asia/Kolkata (YYYY-MM-DD and 24-hour HH:MM).',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isEventEmail: { type: Type.BOOLEAN },
            confidence: {
              type: Type.STRING,
              description: 'One of: high, medium, low',
            },
            title: { type: Type.STRING },
            date: { type: Type.STRING, description: 'YYYY-MM-DD in Asia/Kolkata' },
            startTime: { type: Type.STRING, description: 'HH:MM 24h in Asia/Kolkata' },
            durationMinutes: { type: Type.NUMBER },
            location: { type: Type.STRING },
            link: { type: Type.STRING },
            summary: { type: Type.STRING },
          },
          required: ['isEventEmail', 'confidence', 'title', 'date', 'startTime', 'summary'],
        },
      },
    })
  );

  try {
    const parsed = JSON.parse(response.text || '{}') as Partial<EmailClassification>;
    const conf =
      parsed.confidence === 'high' || parsed.confidence === 'medium'
        ? parsed.confidence
        : 'low';
    return {
      isEventEmail: Boolean(parsed.isEventEmail),
      confidence: conf,
      title: parsed.title || email.subject,
      date: parsed.date || getTodayIstDate(),
      startTime: parsed.startTime || '10:00',
      durationMinutes: Number(parsed.durationMinutes) || 120,
      location: parsed.location || 'Online',
      link: parsed.link || '',
      summary: parsed.summary || email.snippet,
    };
  } catch {
    return {
      isEventEmail: false,
      confidence: 'low',
      title: email.subject,
      date: getTodayIstDate(),
      startTime: '10:00',
      durationMinutes: 60,
      location: '',
      link: '',
      summary: email.snippet,
    };
  }
}

export interface HackathonDigestItem {
  id: string;
  name: string;
  eventDate: string; // YYYY-MM-DD
  eventTime: string; // HH:MM
  deadline: string;
  location: string;
  link: string;
  description: string;
  source: string;
}

let cachedDigest: { items: HackathonDigestItem[]; timestamp: number } | null = null;
const DIGEST_CACHE_MS = 15 * 60 * 1000;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function toYmd(dateInput?: string | null, fallbackYear?: string): string {
  if (!dateInput) return getTodayIstDate();
  const trimmed = dateInput.trim();
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoMatch) return isoMatch[1];

  const withYear =
    /\b20\d{2}\b/.test(trimmed) || !fallbackYear
      ? trimmed
      : `${trimmed}, ${fallbackYear}`;
  const parsed = new Date(withYear);
  if (!Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2025) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
  }
  return getTodayIstDate();
}

function formatReadableDate(dateInput?: string | null): string {
  if (!dateInput) return 'Open now';
  const parsed = new Date(dateInput);
  if (Number.isNaN(parsed.getTime())) return String(dateInput);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

async function fetchLivePublicHackathons(customQuery?: string): Promise<HackathonDigestItem[]> {
  const results: HackathonDigestItem[] = [];
  const qLower = (customQuery || '').toLowerCase();

  const [unstopRes, devpostRes] = await Promise.allSettled([
    fetch(
      'https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&per_page=10&oppstatus=open',
      { headers: { Accept: 'application/json' } }
    ),
    fetch('https://devpost.com/api/hackathons?status[]=upcoming&status[]=open&page=1', {
      headers: { Accept: 'application/json' },
    }),
  ]);

  if (unstopRes.status === 'fulfilled' && unstopRes.value.ok) {
    try {
      const json = (await unstopRes.value.json()) as {
        data?: {
          data?: Array<{
            id: number;
            title?: string;
            public_url?: string;
            region?: string;
            end_date?: string;
            details?: string;
            organisation?: { name?: string };
            regnRequirements?: { end_regn_dt?: string };
            address_with_country_logo?: { city?: string };
          }>;
        };
      };

      for (const item of json.data?.data || []) {
        const title = (item.title || '').trim();
        if (!title) continue;
        const city = item.address_with_country_logo?.city;
        const location = city
          ? `${city} (${item.region || 'India'})`
          : item.region === 'online'
            ? 'Online (India)'
            : `${item.region || 'India / Online'}`;
        const rawText = stripHtml(item.details || '');
        const firstSentence = rawText.split(/(?<=[.!?])\s+/)[0] || '';
        const org = item.organisation?.name ? `Hosted by ${item.organisation.name}. ` : '';
        const desc = (firstSentence || `${org}Open hackathon on Unstop.`).slice(0, 160);

        results.push({
          id: `unstop-${item.id}`,
          name: title,
          eventDate: toYmd(item.end_date || item.regnRequirements?.end_regn_dt),
          eventTime: '10:00',
          deadline: formatReadableDate(item.regnRequirements?.end_regn_dt),
          location,
          link: item.public_url
            ? `https://unstop.com/${item.public_url.replace(/^\//, '')}`
            : 'https://unstop.com/hackathons',
          description: desc,
          source: 'Unstop',
        });
      }
    } catch {
      // Continue with Devpost results
    }
  }

  if (devpostRes.status === 'fulfilled' && devpostRes.value.ok) {
    try {
      const json = (await devpostRes.value.json()) as {
        hackathons?: Array<{
          id: number;
          title?: string;
          url?: string;
          displayed_location?: { location?: string };
          submission_period_dates?: string;
          time_left_to_submission?: string;
          organization_name?: string;
          themes?: Array<{ name: string }>;
        }>;
      };

      for (const item of json.hackathons || []) {
        const title = (item.title || '').trim();
        if (!title) continue;
        const period = item.submission_period_dates || '';
        const yearMatch = /\b(20\d{2})\b/.exec(period);
        const fallbackYear = yearMatch ? yearMatch[1] : getTodayIstDate().slice(0, 4);
        const endPart = period.split('-')[1]?.trim() || period.split('-')[0]?.trim();
        const themeNames = (item.themes || [])
          .slice(0, 3)
          .map((t) => t.name)
          .join(', ');
        const org = item.organization_name ? `by ${item.organization_name}` : 'on Devpost';
        const desc = themeNames
          ? `Hackathon ${org} covering ${themeNames}.`
          : `Upcoming hackathon ${org}.`;

        results.push({
          id: `devpost-${item.id}`,
          name: title,
          eventDate: toYmd(endPart, fallbackYear),
          eventTime: '10:00',
          deadline: item.time_left_to_submission || item.submission_period_dates || 'Upcoming',
          location: item.displayed_location?.location || 'Online',
          link: item.url || 'https://devpost.com/hackathons',
          description: desc,
          source: 'Devpost',
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (qLower) {
    const terms = qLower
      .split(/\s+/)
      .filter((t) => t.length > 2 && !['find', 'hackathons', 'events', 'upcoming', 'tech'].includes(t));
    if (terms.length > 0) {
      const matched = results.filter((r) => {
        const hay = `${r.name} ${r.location} ${r.description} ${r.source}`.toLowerCase();
        return terms.some((term) => hay.includes(term));
      });
      if (matched.length > 0) return matched;
    }
  }

  return results;
}

export async function searchHackathonsDigest(
  customQuery?: string,
  seenKeys: string[] = []
): Promise<HackathonDigestItem[]> {
  const seenLower = new Set(seenKeys.map((s) => s.toLowerCase()));

  if (
    !customQuery &&
    cachedDigest &&
    Date.now() - cachedDigest.timestamp < DIGEST_CACHE_MS &&
    cachedDigest.items.length > 0
  ) {
    const filtered = cachedDigest.items.filter(
      (item) => !seenLower.has(item.name.toLowerCase())
    );
    if (filtered.length > 0) return filtered.slice(0, 5);
  }

  // 1. Primary path for live web hackathon search without consuming Gemini Search Grounding quota
  const publicItems = await fetchLivePublicHackathons(customQuery);
  const unseenPublic = publicItems.filter(
    (item) => !seenLower.has(item.name.toLowerCase())
  );

  // Interleave Unstop (India/hybrid) and Devpost (global/online) for diverse top 5
  const unstopList = unseenPublic.filter((i) => i.source === 'Unstop');
  const devpostList = unseenPublic.filter((i) => i.source === 'Devpost');
  const blended: HackathonDigestItem[] = [];
  const maxLen = Math.max(unstopList.length, devpostList.length);
  for (let i = 0; i < maxLen && blended.length < 5; i++) {
    if (unstopList[i]) blended.push(unstopList[i]);
    if (blended.length < 5 && devpostList[i]) blended.push(devpostList[i]);
  }

  if (blended.length > 0 && !process.env.TAVILY_API_KEY) {
    if (!customQuery) {
      cachedDigest = { items: blended, timestamp: Date.now() };
    }
    return blended;
  }

  // 2. If Tavily API key is configured, query Tavily + summarize with Gemini in 1 call
  const istNow = getCurrentIstContext();
  const tavilyKey = process.env.TAVILY_API_KEY;
  let tavilyContext = '';

  const searchQuery =
    customQuery ||
    'upcoming hackathons India Bangalore online 2026 2027 Devfolio Unstop MLH Devpost open source programs';

  if (tavilyKey) {
    try {
      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: searchQuery,
          search_depth: 'basic',
          max_results: 8,
        }),
      });
      if (tavilyRes.ok) {
        const tavilyText = await tavilyRes.text();
        if (!tavilyText.trim().startsWith('<')) {
          const tavilyJson = JSON.parse(tavilyText) as {
            results?: Array<{ title?: string; url?: string; content?: string }>;
          };
          tavilyContext = (tavilyJson.results || [])
            .map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.content}`)
            .join('\n\n');
        }
      }
    } catch {
      // Fall back to public feeds or Gemini Search below
    }
  }

  if (!tavilyContext && blended.length > 0) {
    if (!customQuery) {
      cachedDigest = { items: blended, timestamp: Date.now() };
    }
    return blended;
  }

  // 3. Last resort: single-call Gemini Search Grounding (only reached if both public feeds & Tavily returned nothing)
  const ai = getAiClient();
  const seenNote =
    seenKeys.length > 0
      ? `Avoid repeating these already-seen events: ${seenKeys.slice(0, 20).join(', ')}.`
      : '';

  const prompt = tavilyContext
    ? `Extract the top 5 upcoming hackathons/tech events from the research below into clean JSON.\n${seenNote}\nCurrent IST date: ${istNow}.\n\nResearch:\n${tavilyContext}`
    : `Search the web for 5 real upcoming hackathons or tech events in India (especially Bangalore) and online with registration deadlines after ${getTodayIstDate()} (Devfolio, Unstop, MLH, Devpost). ${seenNote} Return JSON array only.`;

  const formatResp = await withModelFallback((model) =>
    ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        thinkingConfig: getThinkingConfig(model),
        tools: tavilyContext ? undefined : [{ googleSearch: {} }],
        systemInstruction:
          'Return up to 5 upcoming tech events or hackathons as JSON. Use YYYY-MM-DD for eventDate, HH:MM for eventTime (default 10:00), keep description to 1 crisp sentence, and only include valid http/https links.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              eventDate: { type: Type.STRING },
              eventTime: { type: Type.STRING },
              deadline: { type: Type.STRING },
              location: { type: Type.STRING },
              link: { type: Type.STRING },
              description: { type: Type.STRING },
              source: { type: Type.STRING },
            },
            required: ['name', 'eventDate', 'deadline', 'location', 'link', 'description'],
          },
        },
      },
    })
  );

  try {
    const items = JSON.parse(formatResp.text || '[]') as Array<Partial<HackathonDigestItem>>;
    const normalized = items.slice(0, 5).map((item, idx) => ({
      id: `${(item.name || 'hack').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${idx}`,
      name: item.name || 'Upcoming Hackathon',
      eventDate: item.eventDate || getTodayIstDate(),
      eventTime: item.eventTime || '10:00',
      deadline: item.deadline || 'Upcoming',
      location: item.location || 'Online / India',
      link:
        item.link && /^https?:\/\//i.test(item.link)
          ? item.link
          : 'https://devfolio.co/hackathons',
      description: item.description || 'Tech hackathon with upcoming registration deadline.',
      source: item.source || 'Web Digest',
    }));
    if (!customQuery && normalized.length > 0) {
      cachedDigest = { items: normalized, timestamp: Date.now() };
    }
    return normalized;
  } catch {
    return blended;
  }
}
