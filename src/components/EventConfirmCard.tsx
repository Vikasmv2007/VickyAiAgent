import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarCheck, Check, Edit3, X } from 'lucide-react';
import type { CalendarEventRecord, DraftEvent } from '../types';

interface EventConfirmCardProps {
  draft: DraftEvent;
  duplicate?: CalendarEventRecord | null;
  saving: boolean;
  onConfirm: (finalDraft: DraftEvent, forceDuplicate: boolean) => void;
  onCancel: () => void;
}

export const EventConfirmCard: React.FC<EventConfirmCardProps> = ({
  draft,
  duplicate,
  saving,
  onConfirm,
  onCancel,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<DraftEvent>(draft);

  useEffect(() => {
    setForm(draft);
    setIsEditing(false);
  }, [draft]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(form, Boolean(duplicate));
  };

  return (
    <div className="mt-5 rounded-2xl border border-blue-500/25 bg-[#161B26] p-5 shadow-lg">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-blue-400">
            {duplicate ? 'Duplicate Event Detected' : 'Confirm Calendar Event'}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-white truncate">
            {form.title || 'Untitled Event'}
          </h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel event draft"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {duplicate && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>
            &ldquo;{duplicate.title}&rdquo; already exists on {form.date}. You can discard this or edit the details before saving.
          </span>
        </div>
      )}

      {!isEditing ? (
        <div className="mt-4 space-y-2.5 text-sm text-slate-300">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-slate-200">
            <span>{form.date}</span>
            <span aria-hidden="true" className="text-slate-500">·</span>
            <span>{form.startTime} IST</span>
            <span aria-hidden="true" className="text-slate-500">·</span>
            <span>{form.durationMinutes} min</span>
          </div>

          {form.location && (
            <p className="text-xs text-slate-400">
              Location: <span className="text-slate-200">{form.location}</span>
            </p>
          )}
          {form.link && (
            <p className="truncate text-xs text-slate-400">
              Link:{' '}
              <a
                href={/^https?:\/\//i.test(form.link) ? form.link : '#'}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 underline-offset-2 hover:underline"
              >
                {form.link}
              </a>
            </p>
          )}
          <p className="text-xs text-slate-400">
            Reminders: 1 day and 1 hour before · Timezone: Asia/Kolkata
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2.5 pt-2">
            <button
              type="button"
              disabled={saving || !form.title.trim()}
              onClick={() => onConfirm(form, Boolean(duplicate))}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {saving ? 'Saving...' : duplicate ? 'Add Anyway' : 'Confirm & Save'}
            </button>

            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              <Edit3 className="h-4 w-4" aria-hidden="true" />
              Edit
            </button>

            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:text-white whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-400">Event Title</label>
            <input
              type="text"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-400">Date (IST)</label>
              <input
                type="date"
                required
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Start Time (IST)</label>
              <input
                type="time"
                required
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Duration (min)</label>
              <input
                type="number"
                min={15}
                max={10080}
                value={form.durationMinutes}
                onChange={(e) =>
                  setForm({ ...form, durationMinutes: Number(e.target.value) || 60 })
                }
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-400">Location</label>
              <input
                type="text"
                placeholder="Online or venue"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Event Link</label>
              <input
                type="url"
                placeholder="https://..."
                value={form.link}
                onChange={(e) => setForm({ ...form, link: e.target.value })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <CalendarCheck className="h-4 w-4" aria-hidden="true" />
              {saving ? 'Saving...' : 'Save to Calendar'}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="inline-flex min-h-[44px] items-center rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
