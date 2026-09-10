// Reading the company's conversations, for the one account allowed to.
//
// Three columns, left to right, each one narrowing the last: every employee → the conversations
// that person is in → what was said in one of them. It is a drill-down rather than a feed, and
// that shape is the point. A feed of every message in the company invites scrolling through
// colleagues' chat out of idle curiosity; a drill-down makes you name the person you are looking
// at before you can read anything, which is the same thing an audit log asks of you.
//
// READ ONLY, and enforced in the database rather than here. There is no composer, no delete and no
// edit — but more to the point, messages_insert asks app.is_conversation_member, so a super admin
// posting into somebody else's conversation is refused by Postgres whatever this file does.
//
// Access is app.can_read_conversation's super-admin arm (0119). Nothing in this file checks a
// permission; for anybody else every query below simply returns nothing.
import React, { useState, useMemo } from 'react';
import {
  Search, Loader2, Users, ChevronRight, ShieldAlert, ArrowLeft, FileText, Image as ImageIcon, Video, Mic,
} from 'lucide-react';
import { useEmployees } from '../data/employees';
import { useEmployeeConversations, useMessages, useMediaUrl } from '../data/messages';
import { conversationName, others, groupByDay } from '../lib/conversations';
import { humanDbError } from '../lib/dbErrors';
import { relativeTime, istToday } from '../lib/dates';
import Avatar from './ui/Avatar';
import './chatMonitor.css';

const clockOf = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

function dayLabel(day) {
  const today = istToday();
  if (day === today) return 'Today';
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  try { return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return day; }
}

export default function ChatMonitor() {
  const [personId, setPersonId] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [query, setQuery] = useState('');

  const { data: employees = [], isLoading: loadingPeople } = useEmployees();
  const conversations = useEmployeeConversations(personId);
  const messages = useMessages(conversationId);

  const person = employees.find((e) => e.id === personId) ?? null;
  const conversation = (conversations.data ?? []).find((c) => c.id === conversationId) ?? null;

  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return employees;
    return employees.filter(
      (e) => (e.full_name || '').toLowerCase().includes(needle)
        || (e.employee_code || '').toLowerCase().includes(needle)
        || (e.branch?.code || '').toLowerCase().includes(needle)
    );
  }, [employees, query]);

  // Picking a different person invalidates the conversation under it — without this the third
  // column keeps showing the previous person's chat while the second column lists somebody else's.
  const choosePerson = (id) => {
    setPersonId(id);
    setConversationId(null);
  };

  return (
    <div className="page-shell chat-monitor">
      <div>
        <h1><ShieldAlert size={18} /> Chat Monitor</h1>
        <p>
          Every conversation in the company, read-only. Pick a person, then one of their
          conversations. This is logged as an administrator action by nature of who can reach it —
          use it for a dispute or an investigation, not for browsing.
        </p>
      </div>

      <div className="chat-monitor-columns" data-step={conversation ? 'thread' : person ? 'conversations' : 'people'}>
        {/* ---- 1. everybody ---- */}
        <section className="chat-monitor-column chat-monitor-people" aria-label="People">
          <header>
            <h2>People</h2>
            <span>{people.length}</span>
          </header>
          <label className="chat-monitor-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, code or branch…"
              aria-label="Search people"
            />
          </label>
          <div className="chat-monitor-scroll">
            {loadingPeople && <p className="chat-monitor-note"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
            {!loadingPeople && people.length === 0 && <p className="chat-monitor-note">Nobody matches that.</p>}
            {people.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => choosePerson(e.id)}
                aria-current={e.id === personId ? 'true' : undefined}
                className="chat-monitor-row"
              >
                <Avatar name={e.full_name} size="sm" />
                <span>
                  <strong>{e.full_name}</strong>
                  <small>{e.employee_code}{e.branch?.code ? ` · ${e.branch.code}` : ''}</small>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        {/* ---- 2. who that person talks to ---- */}
        <section className="chat-monitor-column chat-monitor-conversations" aria-label="Conversations">
          <header>
            <button type="button" className="chat-monitor-back" onClick={() => setPersonId(null)} aria-label="Back to people">
              <ArrowLeft size={16} />
            </button>
            <h2>{person ? person.full_name : 'Conversations'}</h2>
            {conversations.data && <span>{conversations.data.length}</span>}
          </header>
          <div className="chat-monitor-scroll">
            {!person && <p className="chat-monitor-note">Pick somebody on the left.</p>}
            {person && conversations.isLoading && <p className="chat-monitor-note"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
            {person && conversations.error && (
              <p className="chat-monitor-note chat-monitor-error">{humanDbError(conversations.error)}</p>
            )}
            {person && conversations.data?.length === 0 && (
              <p className="chat-monitor-note">{person.full_name} has no conversations.</p>
            )}
            {(conversations.data ?? []).map((c) => {
              // Named from the SELECTED person's side, not the viewer's — the question this column
              // answers is "who does this employee talk to", so `me` is them.
              const name = conversationName(c, personId);
              const withWhom = others(c, personId);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setConversationId(c.id)}
                  aria-current={c.id === conversationId ? 'true' : undefined}
                  className="chat-monitor-row"
                >
                  {c.kind === 'group'
                    ? <span className="chat-monitor-groupicon"><Users size={15} /></span>
                    : <Avatar name={name} size="sm" />}
                  <span>
                    <strong>{name}</strong>
                    <small>
                      {c.kind === 'group' ? `Group · ${withWhom.length + 1} people` : 'Direct'}
                      {c.last_message_at ? ` · ${relativeTime(c.last_message_at)}` : ''}
                    </small>
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>

        {/* ---- 3. what was said ---- */}
        <section className="chat-monitor-column chat-monitor-thread" aria-label="Messages">
          <header>
            <button type="button" className="chat-monitor-back" onClick={() => setConversationId(null)} aria-label="Back to conversations">
              <ArrowLeft size={16} />
            </button>
            <h2>{conversation ? conversationName(conversation, personId) : 'Messages'}</h2>
            <span className="chat-monitor-readonly">Read only</span>
          </header>
          <div className="chat-monitor-scroll chat-monitor-history">
            {!conversation && <p className="chat-monitor-note">Pick a conversation.</p>}
            {conversation && messages.isLoading && <p className="chat-monitor-note"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
            {conversation && messages.error && (
              <p className="chat-monitor-note chat-monitor-error">{humanDbError(messages.error)}</p>
            )}
            {conversation && messages.data?.length === 0 && (
              <p className="chat-monitor-note">Nothing was ever said here.</p>
            )}
            {groupByDay(messages.data ?? []).map(({ day, messages: rows }) => (
              <div key={day}>
                <p className="chat-monitor-day"><span>{dayLabel(day)}</span></p>
                {rows.map((m) => <MonitorMessage key={m.id} message={m} personId={personId} />)}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * One message, as an observer sees it.
 *
 * Aligned by whether the SELECTED person sent it, so a whole thread reads as "their side / the
 * other side" rather than being centred on the administrator, who is in none of it.
 *
 * A deleted message is shown as deleted rather than hidden. Its absence would be a hole in the
 * record for the one reader whose purpose is the record — and 0115 keeps the row precisely so this
 * screen can say a message existed.
 */
function MonitorMessage({ message, personId }) {
  const theirs = message.sender_id === personId;

  return (
    <div className="chat-monitor-message" data-side={theirs ? 'subject' : 'other'}>
      <div className="chat-monitor-bubble">
        <p className="chat-monitor-sender">{message.sender?.full_name ?? 'Unknown'}</p>
        {message.deleted_at ? (
          <p className="chat-monitor-deleted">Message deleted by sender</p>
        ) : (
          <>
            {message.kind !== 'text' && <MonitorMedia message={message} />}
            {message.body && <p className="chat-monitor-text">{message.body}</p>}
          </>
        )}
        <span className="chat-monitor-time">{clockOf(message.created_at)}</span>
      </div>
    </div>
  );
}

const MEDIA_ICON = { image: ImageIcon, video: Video, voice: Mic, file: FileText };
const MEDIA_LABEL = { image: 'Photo', video: 'Video', voice: 'Voice note', file: 'File' };

/**
 * An attachment, opened on demand.
 *
 * A signed URL is fetched only when the row is on screen, and a photo is shown inline because a
 * monitor that cannot see what was actually sent is not much of a monitor. Video and voice stay as
 * links: autoplaying somebody's voice note while scrolling an investigation is the wrong default.
 */
function MonitorMedia({ message }) {
  const { data: url, isLoading } = useMediaUrl(message.storage_path);
  const Icon = MEDIA_ICON[message.kind] ?? FileText;
  const label = MEDIA_LABEL[message.kind] ?? 'Attachment';

  if (isLoading) return <p className="chat-monitor-attachment"><Loader2 size={13} className="animate-spin" /> {label}…</p>;
  if (!url) return <p className="chat-monitor-attachment"><Icon size={13} /> {label} (unavailable)</p>;

  if (message.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="chat-monitor-photo">
        <img src={url} alt={message.body || 'Shared photo'} loading="lazy" />
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" className="chat-monitor-attachment">
      <Icon size={13} /> {label}
    </a>
  );
}
