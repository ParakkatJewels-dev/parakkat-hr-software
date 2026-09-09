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
  CornerDownRight,
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
import Avatar from './ui/Avatar';
import {
  buildThread, mentionFor, replyToggleLabel, threadingAvailable,
} from '../lib/commentThread';
import { useRevealOnOpen } from '../lib/useRevealOnOpen';

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
  // Opening the link form on a phone put it below the fold, so the button looked inert.
  const linkFormRef = useRevealOnOpen(adding === 'link');

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

      {/* Two inputs and two buttons on one line needed 12rem for the address alone, so at 360px the
          row broke into a ragged stack with Add stranded beside a text field. Stacked on a phone,
          one row from `sm` up. */}
      {adding === 'link' && (
        <form
          ref={linkFormRef}
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try { await addLink.mutateAsync({ taskId, url, label }); setUrl(''); setLabel(''); setAdding(null); }
            catch { /* shown below */ }
          }}
        >
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a link…" aria-label="Link address" className={INPUT} />
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Call it… (optional)" aria-label="Link name" className={INPUT + ' sm:flex-1'} />
            <div className="flex gap-2">
              <button type="submit" disabled={!url.trim() || addLink.isPending} className={btnClass('primary','sm') + ' flex-1 sm:flex-none'}>Add</button>
              <button type="button" onClick={() => setAdding(null)} className={btnClass('ghost','sm') + ' flex-1 sm:flex-none'}>Cancel</button>
            </div>
          </div>
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
                <span className="font-mono text-2xs text-neutral-400 shrink-0 hidden sm:inline">
                  {row.kind === 'file' ? readableSize(row.size_bytes) : ''}
                </span>
                {row.added_by?.full_name && (
                  <Avatar name={row.added_by.full_name} size="xs" className="hidden sm:inline-flex" />
                )}
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

/**
 * The conversation.
 *
 * One level of nesting, matching what 0110 stores and what a phone can actually render: comments
 * down the page, replies tucked under the comment they answer and hidden behind a count until
 * somebody wants them. Answering a reply keeps the conversation on the same thread and seeds the
 * box with that person's name, because the alternative — a deeper indent each time — walks the
 * newest and most relevant remark off the right edge of a 360px screen.
 */
function Thread({ taskId, rows, loading, myUserId }) {
  const [body, setBody] = useState('');
  // Which comment the box is currently answering, and which threads have their replies open.
  const [replyTo, setReplyTo] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const add = useAddTaskComment();
  const remove = useDeleteTaskComment();
  const error = humanDbError(add.error || remove.error, 'task_comments');
  // Keyed on which comment is being answered: switching targets is a new open, or clicking
  // Reply on a second comment moves the chip and leaves the caret behind.
  const composerRef = useRevealOnOpen(Boolean(replyTo), { block: 'center', key: replyTo?.id ?? null });

  const thread = buildThread(rows);
  // 0110 may not be applied yet — the query falls back to the flat shape then. Offering Reply
  // would take somebody's answer and post it as a new top-level comment under a chip promising
  // otherwise, so the affordance is simply absent until the column exists.
  const canReply = threadingAvailable(rows);

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const startReply = (comment, parentId) => {
    setReplyTo({ id: parentId, to: comment });
    setBody(mentionFor(comment));
    // Open the thread being answered, or the reply lands somewhere the writer cannot see.
    setExpanded((prev) => new Set(prev).add(parentId));
  };

  const post = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await add.mutateAsync({ taskId, body, parentId: replyTo?.id ?? null });
      setBody('');
      setReplyTo(null);
    } catch { /* shown below */ }
  };

  return (
    <section className="space-y-2">
      <h4 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 flex items-center gap-1.5">
        <MessageSquare size={11} /> Comments {rows.length > 0 && <span className="font-mono opacity-70">{rows.length}</span>}
      </h4>

      {loading ? (
        <Loader2 size={14} className="animate-spin text-[#0ea971]" />
      ) : thread.length === 0 ? (
        <p className="text-2xs text-neutral-400">Nothing said yet. If it is blocked, this is where to say why.</p>
      ) : (
        <ul className="space-y-3">
          {thread.map((c) => (
            <li key={c.id} className="space-y-1.5">
              <CommentRow
                comment={c}
                mine={c.author_user === myUserId}
                onReply={canReply ? () => startReply(c, c.id) : null}
                onDelete={() => remove.mutate(c.id)}
              />

              {c.replies.length > 0 && (
                <div className="pl-8 sm:pl-10 space-y-1.5">
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    aria-expanded={expanded.has(c.id)}
                    className="flex items-center gap-1.5 text-2xs font-bold text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer py-1"
                  >
                    <span className="w-5 h-px bg-neutral-300 dark:bg-neutral-700 shrink-0" aria-hidden="true" />
                    {replyToggleLabel(c.replies.length, expanded.has(c.id))}
                  </button>

                  {expanded.has(c.id) && c.replies.map((r) => (
                    <CommentRow
                      key={r.id}
                      comment={r}
                      compact
                      mine={r.author_user === myUserId}
                      onReply={canReply ? () => startReply(r, c.id) : null}
                      onDelete={() => remove.mutate(r.id)}
                    />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="text-2xs text-red-600 dark:text-red-300">{error}</p>}

      <div ref={composerRef} className="space-y-1.5">
        {replyTo && (
          <div className="flex items-center gap-2 text-2xs text-neutral-500 dark:text-neutral-400 rounded-lg bg-neutral-50 dark:bg-neutral-950/40 border border-neutral-150 dark:border-neutral-850 px-2.5 py-1.5">
            <CornerDownRight size={11} className="text-[#0ea971] shrink-0" />
            <span className="min-w-0 truncate">
              Replying to <span className="font-semibold text-neutral-700 dark:text-neutral-300">
                {replyTo.to?.author?.full_name ?? 'someone'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => { setReplyTo(null); setBody(''); }}
              aria-label="Cancel reply"
              className="ml-auto p-1 rounded text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <form onSubmit={post} className="flex items-start gap-2">
          <textarea
            rows={1} value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(e); }}
            placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'}
            aria-label={replyTo ? 'Write a reply' : 'Add a comment'}
            className={INPUT + ' resize-none flex-1'}
          />
          <button type="submit" disabled={!body.trim() || add.isPending} className={btnClass('primary','sm')} title="Post (Cmd+Enter)" aria-label="Post comment">
            {add.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          </button>
        </form>
      </div>
    </section>
  );
}

/** One remark: who said it, when, what, and the two things you can do about it. */
function CommentRow({ comment, mine, compact = false, onReply, onDelete }) {
  const name = comment.author?.full_name ?? 'Someone';
  return (
    <div className="flex items-start gap-2">
      <Avatar name={name} size={compact ? 'xs' : 'sm'} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-xs text-neutral-800 dark:text-neutral-200">{name}</span>
          <span className="font-mono text-2xs text-neutral-400">
            {relativeTime(comment.created_at)}{comment.edited_at ? ' · edited' : ''}
          </span>
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap break-words leading-snug mt-0.5">
          {comment.body}
        </p>
        {/* Actions sit under the text rather than beside the name: on a phone a row of name, time
            and two controls has nowhere left for the name. */}
        <div className="flex items-center gap-3 mt-1">
          {onReply && (
            <button
              type="button" onClick={onReply}
              className="text-2xs font-bold text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer py-0.5"
            >
              Reply
            </button>
          )}
          {mine && (
            <button
              type="button" onClick={onDelete}
              aria-label={`Delete ${name}'s comment`}
              className="text-2xs font-bold text-neutral-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer py-0.5"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
