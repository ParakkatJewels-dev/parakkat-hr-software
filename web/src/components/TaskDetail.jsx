// What a task carries and what people said about it.
//
// Folded away by default. The board's job is to answer "what is outstanding" at a glance, and a
// card that always showed a thread and a file list would answer it worse for the ninety per cent of
// tasks that have neither. It opens on the card, in place, so you keep your position in the list.
//
// The thread and the files are only fetched when somebody opens one — see the `enabled` on both
// hooks. Fifty cards must not mean a hundred queries.
import React, { useRef, useState } from 'react';
import {
  MessageSquare, Paperclip, Send, Trash2, Link2, FileText, Download, Loader2, Plus, X,
  CornerDownRight, ListTodo, Square, CheckSquare,
} from 'lucide-react';
import { useTaskComments, useAddTaskComment, useDeleteTaskComment } from '../data/taskComments';
import {
  useTaskAttachments, useAddTaskFile, useTaskFileUrl, useRemoveTaskAttachment,
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
import {
  useChecklist, useAddChecklistItem, useToggleChecklistItem, useDeleteChecklistItem,
} from '../data/taskChecklist';
import { checklistProgress, isItemDone, sortItems, tickedBy } from '../lib/checklist';
import { isAssignedTo } from '../lib/taskBoard';
import { usePermissions } from '../auth/usePermissions';
import { messageLinkParts } from '../lib/messageLinks';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const readableSize = (bytes) =>
  !bytes ? '' : bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`;

export default function TaskDetail({ task, open }) {
  const { user, employee } = useAuth();
  const { canAny } = usePermissions();
  const checklist = useChecklist(task.id, { enabled: open });
  const comments = useTaskComments(task.id, { enabled: open });
  const attachments = useTaskAttachments(task.id, { enabled: open });

  if (!open) return null;

  // Two different questions, and 0114's policies answer them differently.
  //   * Ticking writes YOUR NAME onto a line as the person who did the work, so it is for the
  //     people actually on the task and nobody else — task_checklist_update asks only
  //     app.is_task_assignee.
  //   * Writing the list is editing the task, which a manager may do.
  // Offered generously here on purpose: the database is the authority, and a button that is
  // occasionally refused with a clear message beats one that is missing when it should be there.
  const mine = isAssignedTo(task, employee?.id);
  const canEditList = mine || canAny('task.manage') || canAny('task.update');

  return (
    <div className="mt-3 pt-3 border-t border-neutral-150 dark:border-neutral-850/60 space-y-4">
      <Checklist
        taskId={task.id}
        rows={checklist.data ?? []}
        loading={checklist.isLoading}
        canTick={mine}
        canEdit={canEditList}
      />
      <Thread
        taskId={task.id}
        rows={comments.data ?? []}
        loading={comments.isLoading}
        attachmentRows={attachments.data ?? []}
        attachmentsLoading={attachments.isLoading}
        myUserId={user?.id}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- checklist -- */

/**
 * The steps inside a task, and who ticked each one.
 *
 * Called subtasks on screen, and stored in task_checklist_items — the table name is older than the
 * word. They replace what the parent/child task tree was being used for and did badly: a nested
 * TASK carries an assignee, a status, a due date and a place in a tree, when all anybody wanted was
 * a line to cross off. The trade is deliberate — a line here cannot hold a comment or a file, which
 * is why the one genuinely nested task in production was left as a task rather than flattened into
 * one of these.
 *
 * Ticking the last line closes the task, from the database (app.tg_task_checklist_rollup), not from
 * here. lib/checklist.js mirrors that rule for the screen; the trigger is what actually decides.
 */
function Checklist({ taskId, rows, loading, canTick, canEdit }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const add = useAddChecklistItem();
  const toggle = useToggleChecklistItem();
  const remove = useDeleteChecklistItem();

  const items = sortItems(rows);
  const { total, done, percent } = checklistProgress(items);
  const error = add.error || toggle.error || remove.error;

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    add.mutate(
      { taskId, title, items },
      { onSuccess: () => { setTitle(''); setAdding(false); } }
    );
  };

  // A task with no steps and nobody able to add one has no checklist to speak of. Rendering an
  // empty heading on every such task would put a permanent blank section on most of the board.
  if (total === 0 && !canEdit && !loading) return null;

  return (
    <div className="task-checklist space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          <ListTodo size={11} /> Subtasks
        </p>
        {total > 0 && (
          <span className="text-2xs font-mono text-neutral-500 dark:text-neutral-400">
            {done} of {total}
          </span>
        )}
      </div>

      {total > 0 && (
        <div
          className="h-1 rounded-full bg-neutral-150 dark:bg-neutral-850 overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${percent}% of this task's steps are done`}
        >
          <div className="h-full bg-[#0ea971] transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      )}

      {loading && (
        <p className="flex items-center gap-1.5 text-2xs text-neutral-400">
          <Loader2 size={11} className="animate-spin" /> Loading subtasks…
        </p>
      )}

      {items.map((item) => {
        const isDone = isItemDone(item);
        const by = tickedBy(item);
        return (
          <div key={item.id} className="checklist-row flex items-start gap-2">
            <button
              type="button"
              disabled={!canTick || toggle.isPending}
              onClick={() => toggle.mutate({ taskId, itemId: item.id, done: !isDone })}
              aria-pressed={isDone}
              aria-label={`${isDone ? 'Untick' : 'Tick'} "${item.title}"`}
              title={canTick ? undefined : 'Only the people assigned to this task can tick its subtasks'}
              className={`mt-0.5 shrink-0 transition-colors ${
                canTick ? 'cursor-pointer hover:text-[#0ea971]' : 'cursor-not-allowed opacity-60'
              } ${isDone ? 'text-[#0ea971]' : 'text-neutral-400 dark:text-neutral-500'}`}
            >
              {isDone ? <CheckSquare size={15} /> : <Square size={15} />}
            </button>

            <div className="min-w-0 flex-1">
              <p className={`text-xs leading-snug ${
                isDone
                  ? 'text-neutral-400 dark:text-neutral-500 line-through'
                  : 'text-neutral-800 dark:text-neutral-200'
              }`}>
                {item.title}
              </p>
              {/* The whole point of the feature: not that it is done, but who did it. */}
              {by && (
                <p className="text-2xs text-neutral-400 dark:text-neutral-500 mt-0.5">
                  {by.name} · {relativeTime(by.at)}
                </p>
              )}
            </div>

            {canEdit && (
              <button
                type="button"
                onClick={() => remove.mutate({ taskId, itemId: item.id })}
                aria-label={`Remove subtask "${item.title}"`}
                className="mt-0.5 shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-rose-500 transition-colors cursor-pointer"
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}

      {error && (
        <p className="text-2xs text-rose-600 dark:text-rose-400">{humanDbError(error)}</p>
      )}

      {canEdit && (adding ? (
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (!title.trim()) setAdding(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setTitle(''); setAdding(false); } }}
            placeholder="What is the subtask?"
            maxLength={200}
            className={INPUT + ' text-xs'}
          />
          <button type="submit" disabled={!title.trim() || add.isPending} className={btnClass('primary', 'sm')}>
            {add.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Add'}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 text-2xs font-semibold text-neutral-500 dark:text-neutral-400 hover:text-[#0ea971] transition-colors cursor-pointer"
        >
          <Plus size={11} /> Add subtask
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- files -- */

function Attachments({ rows, loading, myUserId }) {
  const remove = useRemoveTaskAttachment();
  const signed = useTaskFileUrl();
  const error = humanDbError(remove.error || signed.error, 'task_attachments');

  const openFile = async (row) => {
    try {
      const href = await signed.mutateAsync(row.storage_path);
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    } catch { /* shown below */ }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 flex items-center gap-1.5">
          <Paperclip size={11} /> Shared {rows.length > 0 && <span className="font-mono opacity-70">{rows.length}</span>}
        </h4>
      </div>

      {error && <p role="alert" className="text-2xs text-red-600 dark:text-red-300">{error}</p>}

      {loading ? (
        <Loader2 size={14} className="animate-spin text-[#0ea971]" />
      ) : rows.length === 0 ? (
        <p className="text-2xs text-neutral-400">No files shared yet.</p>
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
function Thread({ taskId, rows, loading, attachmentRows, attachmentsLoading, myUserId }) {
  const [body, setBody] = useState('');
  const [pendingFile, setPendingFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  // Which comment the box is currently answering, and which threads have their replies open.
  const [replyTo, setReplyTo] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const add = useAddTaskComment();
  const addFile = useAddTaskFile();
  const remove = useDeleteTaskComment();
  const messageRef = useRef(null);
  const fileInputRef = useRef(null);
  const error = fileError?.message
    || (addFile.error ? humanDbError(addFile.error, 'task_attachments') : null)
    || humanDbError(add.error || remove.error, 'task_comments');
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

  const chooseFile = (file) => {
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_TASK_FILE_BYTES) {
      setPendingFile(null);
      setFileError(new Error(`That file is ${readableSize(file.size)}. The limit is ${Math.round(MAX_TASK_FILE_BYTES / 1048576)} MB.`));
      return;
    }
    setPendingFile(file);
  };

  const post = async (e) => {
    e?.preventDefault?.();
    const text = body.trim();
    if (!text && !pendingFile) return;
    try {
      // Upload first. If the remark fails afterwards the file is already safely attached and is
      // cleared from the composer, so pressing Send again cannot upload a duplicate.
      if (pendingFile) {
        await addFile.mutateAsync({ taskId, file: pendingFile });
        setPendingFile(null);
      }
      if (text) await add.mutateAsync({ taskId, body: text, parentId: replyTo?.id ?? null });
      setBody('');
      setReplyTo(null);
      setFileError(null);
      if (messageRef.current) messageRef.current.style.height = 'auto';
    } catch { /* shown below */ }
  };

  const busy = add.isPending || addFile.isPending;

  return (
    <section className="space-y-2">
      <h4 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 flex items-center gap-1.5">
        <MessageSquare size={11} /> Task conversation {rows.length > 0 && <span className="font-mono opacity-70">{rows.length}</span>}
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

      {(attachmentsLoading || attachmentRows.length > 0) && (
        <Attachments rows={attachmentRows} loading={attachmentsLoading} myUserId={myUserId} />
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

        <form onSubmit={post} className="task-message-composer">
          {pendingFile && (
            <div className="task-message-file" role="status">
              <FileText size={14} />
              <span title={pendingFile.name}>{pendingFile.name}</span>
              <small>{readableSize(pendingFile.size)}</small>
              <button
                type="button"
                onClick={() => setPendingFile(null)}
                aria-label={`Remove ${pendingFile.name}`}
              >
                <X size={13} />
              </button>
            </div>
          )}

          <div className="task-message-input-row">
            <button
              type="button"
              className="task-message-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title={`Attach a file (up to ${Math.round(MAX_TASK_FILE_BYTES / 1048576)} MB)`}
              aria-label="Attach a file"
            >
              <Paperclip size={17} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ACCEPTED_TASK_FILES}
              disabled={busy}
              aria-label="Choose a file to attach"
              onChange={(e) => {
                chooseFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <textarea
              ref={messageRef}
              rows={1}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
              }}
              onKeyDown={(e) => {
                // The conversation behaves like messaging: Enter sends and Shift+Enter makes a line.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  post();
                }
              }}
              placeholder={replyTo ? 'Write a reply…' : 'Write a message or paste a link…'}
              aria-label={replyTo ? 'Write a reply' : 'Add a comment'}
              className="task-message-input"
              maxLength={4000}
            />
            <button
              type="submit"
              disabled={busy || (!body.trim() && !pendingFile)}
              className="task-message-send"
              title="Send"
              aria-label="Send message"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
          <p className="task-message-hint">Enter to send · Shift+Enter for a new line · links become clickable automatically</p>
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
          {messageLinkParts(comment.body).map((part, index) => (
            part.type === 'link' ? (
              <a
                key={`${part.href}-${index}`}
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                className="task-comment-link"
              >
                {part.text}
              </a>
            ) : (
              <React.Fragment key={`text-${index}`}>{part.text}</React.Fragment>
            )
          ))}
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
