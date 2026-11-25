import React from 'react';
import { Trash2, X } from 'lucide-react';
import type { CalendarEventRecord } from '../types';

interface DeleteConfirmModalProps {
  event: CalendarEventRecord | null;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  event,
  deleting,
  onConfirm,
  onCancel,
}) => {
  if (!event) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-event-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#14171F] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h3 id="delete-event-heading" className="text-lg font-semibold text-white">
            Delete Calendar Event?
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close delete confirmation"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          Are you sure you want to remove <strong className="text-white">{event.title}</strong> from your Google Calendar? This action cannot be undone.
        </p>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50 whitespace-nowrap"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {deleting ? 'Deleting...' : 'Delete Event'}
          </button>
        </div>
      </div>
    </div>
  );
};
