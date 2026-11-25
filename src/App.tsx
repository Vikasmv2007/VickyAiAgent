import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Check,
  ExternalLink,
  Flame,
  Inbox,
  LogOut,
  Mail,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { EventConfirmCard } from './components/EventConfirmCard';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import {
  connectGoogleAccount,
  disconnectGoogleAccount,
  getPrimaryAccount,
  initAuthListener,
  setPrimaryGoogleAccount,
} from './lib/googleAuth';
import { safeFetchJson } from './lib/safeFetch';
import type {
  AppTab,
  CalendarEventRecord,
  ConnectedAccount,
  DraftEvent,
  GmailPendingEvent,
  GmailScanSummary,
  HackathonDigestItem,
} from './types';

function formatIstDateTime(iso: string, isAllDay?: boolean): { dateLabel: string; timeLabel: string } {
  if (!iso) return { dateLabel: 'TBD', timeLabel: '' };
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { dateLabel: iso, timeLabel: '' };
  }
  const dateLabel = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(parsed);

  if (isAllDay) {
    return { dateLabel, timeLabel: 'All day' };
  }

  const timeLabel = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(parsed);

  return { dateLabel, timeLabel: `${timeLabel} IST` };
}

function getTodayIstString(): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return nowIst.toISOString().slice(0, 10);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Calendar state
  const [calendarRange, setCalendarRange] = useState<'today' | 'week' | 'upcoming'>('upcoming');
  const [events, setEvents] = useState<CalendarEventRecord[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  // Assistant / Voice state
  const [inputText, setInputText] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantReply, setAssistantReply] = useState<string | null>(null);
  const [draftEvent, setDraftEvent] = useState<DraftEvent | null>(null);
  const [draftDuplicate, setDraftDuplicate] = useState<CalendarEventRecord | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<CalendarEventRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Gmail scanner state
  const [scanningGmail, setScanningGmail] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [pendingGmailEvents, setPendingGmailEvents] = useState<GmailPendingEvent[]>([]);
  const [scanSummary, setScanSummary] = useState<GmailScanSummary | null>(null);
  const processedEmailIdsRef = useRef<Set<string>>(new Set());

  // Hackathon digest state
  const [digestItems, setDigestItems] = useState<HackathonDigestItem[]>([]);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);
  const seenHackathonsRef = useRef<Set<string>>(new Set());

  const primaryAccount = useMemo(
    () => accounts.find((a) => a.isPrimary) || accounts[0] || null,
    [accounts]
  );

  useEffect(() => {
    const unsub = initAuthListener(() => {
      setAccounts([]);
      setEvents([]);
    });
    return unsub;
  }, []);

  const fetchCalendarEvents = useCallback(
    async (rangeOverride?: 'today' | 'week' | 'upcoming') => {
      const acct = getPrimaryAccount();
      if (!acct) return;

      const targetRange = rangeOverride || calendarRange;
      setEventsLoading(true);
      setEventsError(null);
      try {
        const { ok, status, data } = await safeFetchJson<{
          events?: CalendarEventRecord[];
          error?: string;
        }>(`/api/calendar/events?range=${encodeURIComponent(targetRange)}`, {
          headers: { Authorization: `Bearer ${acct.accessToken}` },
        });
        if (!ok) {
          if (status === 401) {
            setAuthError('Your Google session expired. Sign in again to refresh calendar access.');
          }
          throw new Error(data.error || 'Could not load calendar events.');
        }
        setEvents(data.events || []);
      } catch (err) {
        setEventsError(err instanceof Error ? err.message : 'Unable to load events.');
      } finally {
        setEventsLoading(false);
      }
    },
    [calendarRange]
  );

  useEffect(() => {
    if (primaryAccount) {
      fetchCalendarEvents();
    }
  }, [primaryAccount, calendarRange, fetchCalendarEvents]);

  const handleFetchDigest = useCallback(async (customQuery?: string) => {
    setDigestLoading(true);
    setDigestError(null);
    try {
      const { ok, data } = await safeFetchJson<{
        items?: HackathonDigestItem[];
        error?: string;
      }>('/api/hackathons/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: customQuery,
          seenKeys: Array.from(seenHackathonsRef.current),
        }),
      });
      if (!ok) {
        throw new Error(data.error || 'Unable to load hackathon digest.');
      }
      const nextItems = data.items || [];
      nextItems.forEach((item) => {
        seenHackathonsRef.current.add(item.name);
      });
      setDigestItems(nextItems);
    } catch (err) {
      setDigestError(err instanceof Error ? err.message : 'Could not fetch digest.');
    } finally {
      setDigestLoading(false);
    }
  }, []);

  // Load initial digest once on mount
  useEffect(() => {
    handleFetchDigest();
  }, [handleFetchDigest]);

  const handleScanGmail = useCallback(async () => {
    if (accounts.length === 0) {
      setAssistantReply('Connect a Google account first to scan Gmail for event confirmations.');
      return;
    }

    setScanningGmail(true);
    try {
      const { ok, data } = await safeFetchJson<{
        newlyProcessedIds?: string[];
        autoAdded?: GmailScanSummary['autoAdded'];
        duplicates?: GmailScanSummary['duplicates'];
        needsConfirmation?: GmailPendingEvent[];
        accountErrors?: GmailScanSummary['accountErrors'];
        error?: string;
      }>('/api/gmail/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounts: accounts.map((a) => ({ email: a.email, accessToken: a.accessToken })),
          primaryCalendarToken: primaryAccount?.accessToken,
          processedIds: Array.from(processedEmailIdsRef.current),
        }),
      });
      if (!ok) {
        throw new Error(data.error || 'Gmail scan failed.');
      }

      (data.newlyProcessedIds || []).forEach((id) => processedEmailIdsRef.current.add(id));

      if (data.needsConfirmation && data.needsConfirmation.length > 0) {
        setPendingGmailEvents((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const uniqueNew = data.needsConfirmation!.filter((item) => !existingIds.has(item.id));
          return [...uniqueNew, ...prev];
        });
      }

      setScanSummary({
        scannedAt: new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kolkata',
        }),
        autoAdded: data.autoAdded || [],
        duplicates: data.duplicates || [],
        accountErrors: data.accountErrors || [],
      });

      if ((data.autoAdded || []).length > 0) {
        fetchCalendarEvents();
      }
    } catch (err) {
      setAssistantReply(err instanceof Error ? err.message : 'Failed to scan Gmail.');
    } finally {
      setScanningGmail(false);
    }
  }, [accounts, primaryAccount, fetchCalendarEvents]);

  // Automatic 30-minute Gmail scan cadence while app is open
  useEffect(() => {
    if (!autoScanEnabled || accounts.length === 0) return;
    const interval = window.setInterval(() => {
      handleScanGmail();
    }, 30 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [autoScanEnabled, accounts.length, handleScanGmail]);

  const handleAssistantSubmit = useCallback(
    async (textToProcess: string) => {
      const cleaned = textToProcess.trim();
      if (!cleaned) return;

      setAssistantBusy(true);
      setAssistantReply(null);
      setDraftEvent(null);
      setDraftDuplicate(null);

      try {
        const { ok, data } = await safeFetchJson<{
          action?: string;
          reply?: string;
          draftEvent?: DraftEvent;
          duplicate?: CalendarEventRecord;
          events?: CalendarEventRecord[];
          range?: 'today' | 'week' | 'upcoming';
          targetEvent?: CalendarEventRecord;
          items?: HackathonDigestItem[];
          error?: string;
        }>('/api/assistant', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(primaryAccount ? { Authorization: `Bearer ${primaryAccount.accessToken}` } : {}),
          },
          body: JSON.stringify({ message: cleaned }),
        });

        if (!ok) {
          throw new Error(data.error || 'Assistant could not process that request.');
        }

        if (data.reply) {
          setAssistantReply(data.reply);
        }

        if (data.action === 'confirm_event' && data.draftEvent) {
          setDraftEvent(data.draftEvent);
          setDraftDuplicate(null);
        } else if (data.action === 'duplicate_found' && data.draftEvent) {
          setDraftEvent(data.draftEvent);
          setDraftDuplicate(data.duplicate || null);
        } else if (data.action === 'list_events' && data.events) {
          if (data.range) setCalendarRange(data.range);
          setEvents(data.events);
        } else if (data.action === 'confirm_delete' && data.targetEvent) {
          setDeleteTarget(data.targetEvent);
        } else if (data.action === 'hackathon_digest' && data.items) {
          data.items.forEach((item) => {
            seenHackathonsRef.current.add(item.name);
          });
          setDigestItems(data.items);
          setActiveTab('digest');
        } else if (data.action === 'trigger_email_scan') {
          handleScanGmail();
        }
      } catch (err) {
        setAssistantReply(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setAssistantBusy(false);
      }
    },
    [primaryAccount, handleScanGmail]
  );

  const {
    isSupported: speechSupported,
    isListening,
    interimText,
    speechError,
    startListening,
    stopListening,
  } = useSpeechRecognition((finalTranscript) => {
    setInputText(finalTranscript);
    handleAssistantSubmit(finalTranscript);
  });

  const formatAuthError = (err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : fallback;
    if (msg.includes('popup-closed-by-user')) {
      return 'Sign-in popup was closed before completing. If Google showed "Access blocked (403)", add that Gmail address under Test Users in Google Cloud Console.';
    }
    if (msg.includes('popup-blocked')) {
      return 'Browser blocked the Google sign-in popup. Please allow popups for this site.';
    }
    if (msg.includes('access_denied') || msg.includes('403')) {
      return 'Access blocked by Google testing mode. Add this email under OAuth Consent Screen -> Audience -> Test Users in Google Cloud Console.';
    }
    return msg;
  };

  const handlePrimarySignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const updated = await connectGoogleAccount({ makePrimary: true, forceSelect: false });
      setAccounts(updated);
    } catch (err) {
      setAuthError(formatAuthError(err, 'Google sign-in failed.'));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAddAnotherGmail = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const updated = await connectGoogleAccount({
        makePrimary: accounts.length === 0,
        forceSelect: true,
      });
      setAccounts(updated);
    } catch (err) {
      setAuthError(formatAuthError(err, 'Could not connect additional Gmail account.'));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDisconnectAccount = async (email: string) => {
    const updated = await disconnectGoogleAccount(email);
    setAccounts(updated);
    if (updated.length === 0) {
      setEvents([]);
    }
  };

  const handleSetPrimary = (email: string) => {
    const updated = setPrimaryGoogleAccount(email);
    setAccounts(updated);
  };

  const handleConfirmSaveEvent = async (finalDraft: DraftEvent, forceDuplicate: boolean) => {
    if (!primaryAccount) {
      setAssistantReply('Sign in with Google first to save this event to your calendar.');
      return;
    }

    setSavingEvent(true);
    try {
      const { ok, status, data } = await safeFetchJson<{
        event?: CalendarEventRecord;
        duplicate?: CalendarEventRecord;
        error?: string;
      }>('/api/calendar/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${primaryAccount.accessToken}`,
        },
        body: JSON.stringify({
          ...finalDraft,
          skipDuplicateCheck: forceDuplicate,
        }),
      });

      if (status === 409 && data.duplicate) {
        setDraftDuplicate(data.duplicate);
        setAssistantReply(data.error || 'Duplicate event found on that date.');
        return;
      }

      if (!ok) {
        throw new Error(data.error || 'Could not save event.');
      }

      setDraftEvent(null);
      setDraftDuplicate(null);
      setInputText('');
      setAssistantReply(
        `Saved "${data.event?.title || finalDraft.title}" on ${finalDraft.date} at ${finalDraft.startTime} IST with 1-day and 1-hour reminders.`
      );
      await fetchCalendarEvents();
    } catch (err) {
      setAssistantReply(err instanceof Error ? err.message : 'Failed to save event.');
    } finally {
      setSavingEvent(false);
    }
  };

  const handleConfirmDeleteEvent = async () => {
    if (!deleteTarget || !primaryAccount) return;
    setDeleting(true);
    try {
      const { ok, data } = await safeFetchJson<{ error?: string }>(
        `/api/calendar/events/${encodeURIComponent(deleteTarget.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${primaryAccount.accessToken}` },
        }
      );
      if (!ok) {
        throw new Error(data.error || 'Failed to delete event.');
      }
      setEvents((prev) => prev.filter((ev) => ev.id !== deleteTarget.id));
      setAssistantReply(`Removed "${deleteTarget.title}" from Google Calendar.`);
      setDeleteTarget(null);
    } catch (err) {
      setAssistantReply(err instanceof Error ? err.message : 'Could not delete event.');
    } finally {
      setDeleting(false);
    }
  };

  const handleApprovePendingGmail = (item: GmailPendingEvent) => {
    setPendingGmailEvents((prev) => prev.filter((p) => p.id !== item.id));
    setDraftEvent({
      title: item.title,
      date: item.date,
      startTime: item.startTime,
      durationMinutes: item.durationMinutes,
      location: item.location,
      link: item.link,
      description: `${item.summary}\nFrom Gmail: ${item.accountEmail}`,
      autoPrefix: true,
    });
    setDraftDuplicate(null);
    setActiveTab('home');
  };

  const handleDismissPendingGmail = (id: string) => {
    setPendingGmailEvents((prev) => prev.filter((p) => p.id !== id));
  };

  const handleAddHackathonToCalendar = (item: HackathonDigestItem) => {
    setDraftEvent({
      title: item.name,
      date: item.eventDate,
      startTime: item.eventTime || '10:00',
      durationMinutes: 180,
      location: item.location,
      link: item.link,
      description: `${item.description}\nRegistration deadline: ${item.deadline}`,
    });
    setDraftDuplicate(null);
    setActiveTab('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleIgnoreHackathon = (id: string, name: string) => {
    seenHackathonsRef.current.add(name);
    setDigestItems((prev) => prev.filter((item) => item.id !== id));
  };

  const todayIst = getTodayIstString();
  const todaysEvents = useMemo(
    () => events.filter((ev) => ev.start.slice(0, 10) === todayIst),
    [events, todayIst]
  );

  const navItems: Array<{ id: AppTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'home', label: 'Home', icon: Mic },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'gmail', label: 'Inbox', icon: Inbox },
    { id: 'digest', label: 'Digest', icon: Flame },
  ];

  return (
    <div className="min-h-screen bg-[#0B0D11] text-slate-100 pb-20 md:pb-10">
      {/* Three-Zone Top Bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#0B0D11]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
          {/* Zone 1: Single-element Brand Wordmark */}
          <a
            href="#home"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('home');
            }}
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            Vicky
          </a>

          {/* Zone 2: 4 concise single-line nav links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === item.id
                    ? 'text-white underline decoration-blue-500 decoration-2 underline-offset-8'
                    : 'hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 primary action + optional PWA install */}
          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
            {primaryAccount ? (
              <button
                type="button"
                onClick={() => setActiveTab('gmail')}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-white/10 bg-[#14171F] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-[#191D26] whitespace-nowrap shrink-0"
              >
                <span className="max-w-[140px] truncate">{primaryAccount.email}</span>
              </button>
            ) : (
              <GoogleSignInButton onClick={handlePrimarySignIn} loading={authLoading} label="Connect Google" />
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 lg:pt-8">
        {authError && (
          <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              aria-label="Dismiss error"
              className="text-red-300 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* HOME VIEW */}
        {activeTab === 'home' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left Primary Column */}
            <div className="space-y-6 lg:col-span-7">
              {/* Voice & Text Assistant Hero Card */}
              <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-7">
                <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-white text-balance">
                      Your events and hackathons, one voice away
                    </h1>
                    <p className="mt-1.5 text-sm text-slate-400">
                      Speak or type naturally in IST. Vicky checks duplicates and sets 1-day and 1-hour reminders.
                    </p>
                  </div>
                </div>

                {/* Big Microphone Focal Anchor */}
                <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-[#0B0D11] px-4 py-7 text-center">
                  <button
                    type="button"
                    onClick={isListening ? stopListening : startListening}
                    aria-label={isListening ? 'Stop voice recording' : 'Start voice input'}
                    className={`relative flex h-20 w-20 items-center justify-center rounded-full transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/40 ${
                      isListening
                        ? 'bg-red-500 text-white shadow-lg shadow-red-500/30'
                        : 'bg-blue-600 text-white shadow-lg shadow-blue-600/25 hover:bg-blue-500'
                    }`}
                  >
                    {isListening ? (
                      <MicOff className="h-8 w-8" aria-hidden="true" />
                    ) : (
                      <Mic className="h-8 w-8" aria-hidden="true" />
                    )}
                  </button>

                  <p className="mt-4 text-sm font-medium text-slate-200">
                    {isListening
                      ? interimText || 'Listening... speak your event or question'
                      : speechSupported
                        ? 'Tap the mic to speak'
                        : 'Type your command below'}
                  </p>
                  {speechError && (
                    <p className="mt-1.5 text-xs text-amber-400">{speechError}</p>
                  )}

                  {/* Text Fallback Input */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAssistantSubmit(inputText);
                    }}
                    className="mt-5 flex w-full max-w-xl items-center gap-2"
                  >
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder='Try "Add Smart India Hackathon on 12 Dec at 10 AM"'
                      className="min-h-[46px] flex-1 rounded-xl border border-white/10 bg-[#14171F] px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={assistantBusy || !inputText.trim()}
                      aria-label="Send message to Vicky"
                      className="inline-flex min-h-[46px] min-w-[46px] items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 shrink-0"
                    >
                      <Send className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </form>

                  {/* Quick Prompt Shortcuts */}
                  <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
                    {[
                      'Add Smart India Hackathon on 12 Dec at 10 AM',
                      'What do I have this week?',
                      'Find hackathons in Bangalore',
                    ].map((sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => {
                          setInputText(sample);
                          handleAssistantSubmit(sample);
                        }}
                        className="min-h-[36px] rounded-lg border border-white/[0.08] bg-[#14171F] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-white/20 hover:text-white"
                      >
                        {sample}
                      </button>
                    ))}
                  </div>
                </div>

                {assistantBusy && (
                  <p className="mt-4 text-sm text-blue-400">Thinking...</p>
                )}

                {assistantReply && !assistantBusy && (
                  <div className="mt-4 rounded-xl border border-white/[0.08] bg-[#0B0D11] px-4 py-3 text-sm text-slate-200">
                    {assistantReply}
                  </div>
                )}

                {draftEvent && (
                  <EventConfirmCard
                    draft={draftEvent}
                    duplicate={draftDuplicate}
                    saving={savingEvent}
                    onConfirm={handleConfirmSaveEvent}
                    onCancel={() => {
                      setDraftEvent(null);
                      setDraftDuplicate(null);
                    }}
                  />
                )}
              </section>

              {/* Today's & Upcoming Events */}
              <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Today&apos;s &amp; Upcoming Events</h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {todaysEvents.length} today · Asia/Kolkata
                    </p>
                  </div>

                  <div className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#0B0D11] p-1">
                    {(['today', 'week', 'upcoming'] as const).map((range) => (
                      <button
                        key={range}
                        type="button"
                        onClick={() => setCalendarRange(range)}
                        className={`min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap ${
                          calendarRange === range
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {range === 'week' ? '7 Days' : range}
                      </button>
                    ))}
                  </div>
                </div>

                {!primaryAccount ? (
                  <div className="mt-5 rounded-xl border border-white/[0.06] bg-[#0B0D11] p-5 text-center">
                    <p className="text-sm text-slate-300">
                      Connect your Google account to sync events, check duplicates, and create reminders.
                    </p>
                    <div className="mt-4 flex justify-center">
                      <GoogleSignInButton onClick={handlePrimarySignIn} loading={authLoading} />
                    </div>
                  </div>
                ) : eventsLoading ? (
                  <div className="mt-5 space-y-3">
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />
                    ))}
                  </div>
                ) : eventsError ? (
                  <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-200">
                    {eventsError}
                  </div>
                ) : events.length === 0 ? (
                  <div className="mt-5 rounded-xl border border-white/[0.06] bg-[#0B0D11] p-5 text-center text-sm text-slate-400">
                    No events found for this range. Tap the mic above to add one.
                  </div>
                ) : (
                  <ul className="mt-4 divide-y divide-white/[0.06]">
                    {events.slice(0, 8).map((ev) => {
                      const { dateLabel, timeLabel } = formatIstDateTime(ev.start, ev.isAllDay);
                      const isAuto = ev.title.startsWith('[Auto]');
                      return (
                        <li key={ev.id} className="flex items-start justify-between gap-3 py-3.5">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                              {ev.title}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                              <span className="font-mono text-slate-300">{dateLabel}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-slate-300">{timeLabel}</span>
                              {ev.location && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="truncate max-w-[180px]">{ev.location}</span>
                                </>
                              )}
                              {isAuto && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-blue-400">Auto-added from Gmail</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {ev.htmlLink && (
                              <a
                                href={ev.htmlLink}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${ev.title} in Google Calendar`}
                                className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(ev)}
                              aria-label={`Delete ${ev.title}`}
                              className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            {/* Right Secondary Column */}
            <div className="space-y-6 lg:col-span-5">
              {/* Connected Accounts & Gmail Scanner Summary */}
              <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Connected Accounts</h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Read-only Gmail scan every 30 minutes
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddAnotherGmail}
                    disabled={authLoading}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add Gmail
                  </button>
                </div>

                {accounts.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400">
                    No Google accounts connected yet. Add one or more Gmail accounts to scan for hackathon invites.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-2.5">
                    {accounts.map((acct) => (
                      <li
                        key={acct.email}
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#0B0D11] px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{acct.email}</p>
                          <p className="text-xs text-slate-400">
                            {acct.isPrimary ? 'Primary Calendar + Gmail' : 'Gmail Inbox'} · Connected {acct.connectedAt}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!acct.isPrimary && (
                            <button
                              type="button"
                              onClick={() => handleSetPrimary(acct.email)}
                              className="min-h-[36px] rounded-lg px-2.5 text-xs font-medium text-blue-400 hover:bg-blue-500/10"
                            >
                              Make Primary
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDisconnectAccount(acct.email)}
                            aria-label={`Disconnect ${acct.email}`}
                            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
                          >
                            <LogOut className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {accounts.length > 0 && (
                  <div className="mt-4 flex items-center justify-between gap-3 pt-1">
                    <button
                      type="button"
                      onClick={handleScanGmail}
                      disabled={scanningGmail}
                      className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      {scanningGmail ? 'Scanning...' : 'Scan Inboxes Now'}
                    </button>

                    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={autoScanEnabled}
                        onChange={(e) => setAutoScanEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-white/20 bg-[#0B0D11] text-blue-600 focus:ring-blue-500"
                      />
                      Auto 30m scan
                    </label>
                  </div>
                )}

                {scanSummary && (
                  <div className="mt-4 rounded-xl border border-white/[0.06] bg-[#0B0D11] p-3.5 text-xs text-slate-300">
                    <p className="font-medium text-white">Last scan at {scanSummary.scannedAt} IST</p>
                    {scanSummary.autoAdded.length > 0 ? (
                      <ul className="mt-1.5 space-y-1 text-emerald-300">
                        {scanSummary.autoAdded.map((item) => (
                          <li key={item.event.id}>{item.summary}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-slate-400">
                        No new high-confidence events found in the last 24 hours.
                      </p>
                    )}
                    {scanSummary.accountErrors.map((err) => (
                      <p key={err.email} className="mt-1 text-amber-400">
                        {err.email}: {err.error}
                      </p>
                    ))}
                  </div>
                )}

                {pendingGmailEvents.length > 0 && (
                  <div className="mt-4 space-y-2.5">
                    <p className="text-xs font-medium text-amber-300">
                      Needs Confirmation ({pendingGmailEvents.length})
                    </p>
                    {pendingGmailEvents.slice(0, 3).map((item) => (
                      <div
                        key={item.id}
                        className="rounded-xl border border-amber-500/25 bg-[#0B0D11] p-3.5"
                      >
                        <p className="text-sm font-medium text-white">{item.title}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.date} · {item.startTime} IST · From {item.accountEmail}
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleApprovePendingGmail(item)}
                            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                          >
                            <Check className="h-3.5 w-3.5" /> Yes, review
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDismissPendingGmail(item.id)}
                            className="min-h-[36px] rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                          >
                            Ignore
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Latest Hackathon Digest Card */}
              <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Latest Digest</h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      India &amp; online hackathons · 8:00 AM IST schedule
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleFetchDigest()}
                    disabled={digestLoading}
                    aria-label="Refresh hackathon digest"
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${digestLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                {digestLoading && digestItems.length === 0 ? (
                  <div className="mt-4 space-y-3">
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="h-20 animate-pulse rounded-xl bg-white/[0.04]" />
                    ))}
                  </div>
                ) : digestError ? (
                  <p className="mt-4 text-sm text-amber-300">{digestError}</p>
                ) : digestItems.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400">
                    All caught up. Tap Refresh to search for more upcoming hackathons.
                  </p>
                ) : (
                  <ul className="mt-4 divide-y divide-white/[0.06]">
                    {digestItems.slice(0, 5).map((item) => (
                      <li key={item.id} className="py-3.5 first:pt-1 last:pb-1">
                        <div className="flex items-start justify-between gap-3">
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium text-white hover:text-blue-400 hover:underline"
                          >
                            {item.name}
                          </a>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          <span className="font-mono text-slate-300">{item.eventDate}</span>
                          <span aria-hidden="true"> · </span>
                          <span>Deadline: {item.deadline}</span>
                          <span aria-hidden="true"> · </span>
                          <span>{item.location}</span>
                        </p>
                        <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
                          {item.description}
                        </p>
                        <div className="mt-2.5 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleAddHackathonToCalendar(item)}
                            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-blue-600/20 px-3 py-1.5 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-600/30"
                          >
                            <Plus className="h-3.5 w-3.5" /> Add to calendar
                          </button>
                          <button
                            type="button"
                            onClick={() => handleIgnoreHackathon(item.id, item.name)}
                            className="min-h-[36px] rounded-lg px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                          >
                            Ignore
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        )}

        {/* DEDICATED CALENDAR TAB */}
        {activeTab === 'calendar' && (
          <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-white">Google Calendar</h1>
                <p className="mt-1 text-sm text-slate-400">
                  All times shown in Asia/Kolkata (IST) with 1-day and 1-hour reminders
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#0B0D11] p-1">
                  {(['today', 'week', 'upcoming'] as const).map((range) => (
                    <button
                      key={range}
                      type="button"
                      onClick={() => setCalendarRange(range)}
                      className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                        calendarRange === range
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {range === 'week' ? 'This Week' : range}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => fetchCalendarEvents()}
                  disabled={!primaryAccount || eventsLoading}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${eventsLoading ? 'animate-spin' : ''}`} />
                  Sync
                </button>
              </div>
            </div>

            {!primaryAccount ? (
              <div className="mt-6 rounded-xl border border-white/[0.06] bg-[#0B0D11] p-8 text-center">
                <p className="text-sm text-slate-300">
                  Connect your Google account to view and manage your calendar events.
                </p>
                <div className="mt-4 flex justify-center">
                  <GoogleSignInButton onClick={handlePrimarySignIn} loading={authLoading} />
                </div>
              </div>
            ) : events.length === 0 ? (
              <p className="mt-6 text-sm text-slate-400">No events scheduled in this range.</p>
            ) : (
              <ul className="mt-6 divide-y divide-white/[0.06]">
                {events.map((ev) => {
                  const { dateLabel, timeLabel } = formatIstDateTime(ev.start, ev.isAllDay);
                  return (
                    <li key={ev.id} className="flex items-start justify-between gap-4 py-4">
                      <div className="min-w-0">
                        <p className="text-base font-medium text-white">{ev.title}</p>
                        <p className="mt-1 font-mono text-xs text-slate-300">
                          {dateLabel} · {timeLabel}
                          {ev.location ? ` · ${ev.location}` : ''}
                        </p>
                        {ev.description && (
                          <p className="mt-1.5 line-clamp-2 text-xs text-slate-400">
                            {ev.description}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(ev)}
                        aria-label={`Delete ${ev.title}`}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* DEDICATED GMAIL INBOX SCANNER TAB */}
        {activeTab === 'gmail' && (
          <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-white">Multi-Account Gmail Scanner</h1>
                <p className="mt-1 text-sm text-slate-400">
                  Read-only access to detect hackathon and event confirmations across 2+ inboxes
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleAddAnotherGmail}
                  disabled={authLoading}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
                >
                  <UserPlus className="h-4 w-4" /> Add Gmail Account
                </button>
                <button
                  type="button"
                  onClick={handleScanGmail}
                  disabled={accounts.length === 0 || scanningGmail}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  <Mail className="h-4 w-4" /> {scanningGmail ? 'Scanning...' : 'Scan All Inboxes'}
                </button>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              {accounts.map((acct) => (
                <div
                  key={acct.email}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0B0D11] p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{acct.email}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {acct.isPrimary ? 'Primary Calendar + Gmail' : 'Gmail Read-Only'} · Connected {acct.connectedAt}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!acct.isPrimary && (
                      <button
                        type="button"
                        onClick={() => handleSetPrimary(acct.email)}
                        className="min-h-[36px] rounded-lg px-3 text-xs font-medium text-blue-400 hover:bg-blue-500/10"
                      >
                        Set Primary
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDisconnectAccount(acct.email)}
                      className="min-h-[36px] rounded-lg px-3 text-xs text-slate-400 hover:bg-white/5 hover:text-white"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {pendingGmailEvents.length > 0 && (
              <div className="mt-6">
                <h2 className="text-base font-semibold text-white">Uncertain Matches — Please Confirm</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {pendingGmailEvents.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-amber-500/25 bg-[#0B0D11] p-4"
                    >
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-1 font-mono text-xs text-slate-300">
                        {item.date} · {item.startTime} IST · {item.accountEmail}
                      </p>
                      <p className="mt-2 text-xs text-slate-400">{item.summary}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleApprovePendingGmail(item)}
                          className="min-h-[38px] rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                        >
                          Yes, Add to Calendar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDismissPendingGmail(item.id)}
                          className="min-h-[38px] rounded-lg border border-white/10 px-3.5 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                        >
                          No, Skip
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* DEDICATED HACKATHON DIGEST TAB */}
        {activeTab === 'digest' && (
          <section className="rounded-2xl border border-white/[0.08] bg-[#14171F] p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-white">Hackathon &amp; Tech Event Digest</h1>
                <p className="mt-1 text-sm text-slate-400">
                  Top upcoming hackathons from Devfolio, Unstop, MLH, Devpost, Bangalore &amp; online
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleFetchDigest()}
                disabled={digestLoading}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${digestLoading ? 'animate-spin' : ''}`} />
                {digestLoading ? 'Searching...' : 'Find New Hackathons'}
              </button>
            </div>

            {digestItems.length === 0 && !digestLoading ? (
              <p className="mt-6 text-sm text-slate-400">
                No unseen hackathons right now. Tap &ldquo;Find New Hackathons&rdquo; to search again.
              </p>
            ) : (
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                {digestItems.map((item) => (
                  <article
                    key={item.id}
                    className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-[#0B0D11] p-5"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="text-base font-semibold text-white">{item.name}</h2>
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${item.name}`}
                          className="text-slate-400 hover:text-blue-400 shrink-0"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                      <p className="mt-1.5 font-mono text-xs text-slate-300">
                        {item.eventDate} · Deadline: {item.deadline} · {item.location}
                      </p>
                      <p className="mt-2.5 text-sm leading-relaxed text-slate-300">
                        {item.description}
                      </p>
                    </div>

                    <div className="mt-4 flex items-center gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => handleAddHackathonToCalendar(item)}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
                      >
                        <Plus className="h-3.5 w-3.5" /> Add to calendar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleIgnoreHackathon(item.id, item.name)}
                        className="min-h-[40px] rounded-xl border border-white/10 px-4 py-2 text-xs text-slate-300 hover:bg-white/5"
                      >
                        Ignore
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Mobile Fixed Bottom Tab Bar */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.08] bg-[#0B0D11]/95 backdrop-blur-md md:hidden pb-safe"
      >
        <div className="grid h-14 grid-cols-4 items-center">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex min-h-[44px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                  active ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mandatory Explicit Delete Confirmation Modal */}
      <DeleteConfirmModal
        event={deleteTarget}
        deleting={deleting}
        onConfirm={handleConfirmDeleteEvent}
        onCancel={() => setDeleteTarget(null)}
      />

      <OfflineIndicator />
    </div>
  );
}
