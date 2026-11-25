export type AppTab = 'home' | 'calendar' | 'gmail' | 'digest';

export interface ConnectedAccount {
  email: string;
  displayName: string;
  photoURL?: string;
  accessToken: string;
  isPrimary: boolean;
  connectedAt: string;
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

export interface DraftEvent {
  title: string;
  date: string; // YYYY-MM-DD in Asia/Kolkata
  startTime: string; // HH:MM in Asia/Kolkata
  durationMinutes: number;
  location: string;
  link: string;
  description: string;
  autoPrefix?: boolean;
  sourceNote?: string;
}

export interface HackathonDigestItem {
  id: string;
  name: string;
  eventDate: string;
  eventTime: string;
  deadline: string;
  location: string;
  link: string;
  description: string;
  source: string;
}

export interface GmailPendingEvent {
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
}

export interface GmailScanSummary {
  scannedAt: string;
  autoAdded: Array<{
    accountEmail: string;
    event: CalendarEventRecord;
    summary: string;
  }>;
  duplicates: Array<{ accountEmail: string; title: string; date: string }>;
  accountErrors: Array<{ email: string; error: string }>;
}
