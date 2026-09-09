// What a task carries and what people said about it.
//
// Folded away by default. The board's job is to answer "what is outstanding" at a glance, and a
// card that always showed a thread and a file list would answer it worse for the ninety per cent of
// tasks that have neither. It opens on the card, in place, so you keep your position in the list.
//
// The thread and the files are only fetched when somebody opens one — see the `enabled` on both
// hooks. Fifty cards must not mean a hundred queries.
import React, { useState } from 'react';
import {
  MessageSquare, Paperclip, Send, Trash2, Link2, FileText, Download, Loader2, Plus, X,
} from 'lucide-react';
import { useTaskComments, useAddTaskComment, useDeleteTaskComment } from '../data/taskComments';
import {
  useTaskAttachments, useAddTaskLink, useAddTaskFile, useTaskFileUrl, useRemoveTaskAttachment,
  ACCEPTED_TASK_FILES, MAX_TASK_FILE_BYTES,
} from '../data/taskAttachments';
import { useAuth } from '../auth/AuthContext';
import { humanDbError } from '../lib/dbErrors';
import { relativeTime } from '../lib/dates';
import { btnClass } from './ui/Btn';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const readableSize = (bytes) =>
  !bytes ? '' : bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TaskDetail({ task, open }) {
  const { user } = useAuth();
  const comments = useTaskComments(task.id, { enabled: open });
  const attachments = useTaskAttachments(task.id, { enabled: open });

  if (!open) return null;

  return (
    <div className="mt-3 pt-3 border-t border-neutral-150 dark:border-neutral-850/60 space-y-4">
      <Attachments taskId={task.id} rows={attachments.data ?? []} loading={attachments.isLoading} myUserId={user?.id} />
      <Thread taskId={task.id} rows={comments.data ?? []} loading={comments.isLoading} myUserId={user?.id} />
    </div>
  );
}

/* -------------------------------------------------------------------- files -- */

function Attachments({ taskId, rows, loading, myUserId }) {
  const [adding, setAdding] = useState(null);   // 'link' | null
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const addLink = useAddTaskLink();
  const addFile = useAddTaskFile();
  const remove = useRemoveTaskAttachment();
  const signed = useTaskFileUrl();
  const error = humanDbError(addLink.error || addFile.error || remove.error, 'task_attachments');

  const openFile = async (row) => {
    try {
      const href = await signed.mutateAsync(row.storage_path);
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    } catch { /* shown below */ }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 flex items-center gap-1.5">
          <Paperclip size={11} /> Attachments {rows.length > 0 && <span className="font-mono opacity-70">{rows.length}</span>}
        </h4>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setAdding(adding === 'link' ? null : 'link')} className={btnClass('ghost','sm')}>
            <Link2 size={12} /> Link
          </button>
          <label className={`${btnClass('ghost','sm')} ${addFile.isPending ? 'opacity-60' : ''}`}>
            {addFile.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} File
            <input
              type="file" className="hidden" accept={ACCEPTED_TASK_FILES}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';   // so picking the same file twice still fires
                if (file) addFile.mutate({ taskId, file });
              }}
            />
          </label>
        </div>
      </div>

      {adding === 'link' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try { await addLink.mutateAsync({ taskId, url, label }); setUrl(''); setLabel(''); setAdding(null); }
            catch { /* shown below */ }
          }}
        >
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a link…" aria-label="Link address" className={INPUT + ' flex-1 min-w-[12rem]'} autoFocus />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Call it… (optional)" aria-label="Link name" className={INPUT + ' w-40'} />
          <button type="submit" disabled={!url.trim() || addLink.isPending} className={btnClass('primary','sm')}>Add</button>
          <button type="button" onClick={() => setAdding(null)} className={btnClass('ghost','sm')}><X size={12} /></button>
        </form>
      )}

      {error && <p role="alert" className="text-2xs text-red-600 dark:text-red-300">{error}</p>}

      {loading ? (
        <Loader2 size={14} className="animate-spin text-[#0ea971]" />
      ) : rows.length === 0 ? (
        <p className="text-2xs text-neutral-400">Nothing attached. A photo of the problem, or a link to the spec.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 bg-neutral-50 dark:bg-neutral-950/40 border border-neutral-150 dark:border-neutral-850">
              <span className="flex items-center gap-2 min-w-0">
                {row.kind === 'link' ? <Link2 size={12} className="text-[#0ea971] shrink-0" /> : <FileText size={12} className="text-[#0ea971] shrink-0" />}
                {row.kind === 'link' ? (
                  <a href={row.url} target="_blank" rel="noopener noreferrer" className="truncate text-neutral-800 dark:text-neutral-200 hover:underline">
                    {row.label || row.url}
                  </a>
                ) : (
                  <button type="button" onClick={() => openFile(row)} className="truncate text-left text-neutral-800 dark:text-neutral-200 hover:underline cursor-pointer">
                    {row.label || 'File'}
                  </button>
                )}
                <span className="font-mono text-2xs text-neutral-400 shrink-0">
                  {row.kind === 'file' ? readableSize(row.size_bytes) : ''}
                  {row.added_by?.full_name ? ` · ${row.added_by.full_name}` : ''}
                </span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                {row.kind === 'file' && (
                  <button type="button" onClick={() => openFile(row)} title="Open" aria-label={`Open ${row.label || 'file'}`}
                    className="p-1 rounded text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
                    {signed.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  </button>
                )}
                {row.added_user === myUserId && (
                  <button type="button" onClick={() => remove.mutate(row)} title="Remove" aria-label={`Remove ${row.label || 'attachment'}`}
                    className="p-1 rounded text-neutral-400 hover:text-red-500 cursor-pointer">
                    <Trash2 size={12} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-2xs text-neutral-400">Up to {Math.round(MAX_TASK_FILE_BYTES / 1048576)} MB a file.</p>
    </section>
  );
}

/* ----------------------------------------------------------------- comments -- */

function Thread({ taskId, rows, loading, myUserId }) {
  const [body, setBody] = useState('');
  const add = useAddTaskComment();
  const remove = useDeleteTaskComment();
  const error = humanDbError(add.error || remove.error, 'task_comments');

  const post = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    try { await add.mutateAsync({ taskId, body }); setBody(''); }
    catch { /* shown below */ }
  };

  return (
    <section className="space-y-2">
      <h4 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 flex items-center gap-1.5">
        <MessageSquare size={11} /> Comments {rows.length > 0 && <span className="font-mono opacity-70">{rows.length}</span>}
      </h4>

      {loading ? (
        <Loader2 size={14} className="animate-spin text-[#0ea971]" />
      ) : rows.length === 0 ? (
        <p className="text-2xs text-neutral-400">Nothing said yet. If it is blocked, this is where to say why.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((c) => (
            <li key={c.id} className="text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">{c.author?.full_name ?? 'Someone'}</span>
                <span className="font-mono text-2xs text-neutral-400">{relativeTime(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
                {c.author_user === myUserId && (
                  <button type="button" onClick={() => remove.mutate(c.id)} title="Delete comment" aria-label="Delete comment"
                    className="ml-auto p-0.5 rounded text-neutral-300 hover:text-red-500 cursor-pointer">
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <p className="text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap leading-snug mt-0.5">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="text-2xs text-red-600 dark:text-red-300">{error}</p>}

      <form onSubmit={post} className="flex items-start gap-2">
        <textarea
          rows={1} value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(e); }}
          placeholder="Add a comment…" aria-label="Add a comment"
          className={INPUT + ' resize-none flex-1'}
        />
        <button type="submit" disabled={!body.trim() || add.isPending} className={btnClass('primary','sm')} title="Post (Cmd+Enter)">
          {add.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </form>
    </section>
  );
}
