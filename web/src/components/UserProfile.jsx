// The signed-in person's own profile.
//
// DESIGNED AROUND ONE FACT: update_my_profile takes exactly one argument — `_phone`. That is the
// whole of what an employee may change about themselves; HR owns every other field on this page.
// The previous version did not say so anywhere. It laid twenty-odd label/value pairs out at uniform
// weight across six sections, put the one editable field third in the middle list behind a pencil,
// and topped the page with a completion meter reading "75%" — a number nobody could act on, because
// the fields it was counting were HR's to fill in.
//
// So the order here is: who you are, the four facts you actually quote, the one thing you own, then
// what HR holds about you. Nothing is dropped — the earlier request was that every detail show —
// but "Not recorded" eight times crowds out what IS known, so absent fields are collected into one
// quiet line per section instead of taking a row each.
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BriefcaseBusiness,
  Check,
  HeartPulse,
  Loader2,
  Mail,
  Package,
  Phone,
  Settings,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useEmployeeAvatars } from '../data/documents';
import { useEmployee } from '../data/employees';
import { useEmployeeAssets } from '../data/assets';
import { useUpdateMyProfile } from '../data/settings';

const initials = (name) =>
  (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'U';

const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const tenureFrom = (value) => {
  if (!value) return null;
  const joined = new Date(`${value}T00:00:00`);
  if (Number.isNaN(joined.getTime())) return null;
  const today = new Date();
  let months =
    (today.getFullYear() - joined.getFullYear()) * 12 + today.getMonth() - joined.getMonth();
  if (today.getDate() < joined.getDate()) months -= 1;
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return years ? `${years}y ${remainingMonths}m` : `${remainingMonths}m`;
};

/**
 * A group of facts.
 *
 * `fields` is [label, value, extra]; a null value means the field exists but is not on file. Those
 * are named once at the foot of the section rather than each taking a full row — a section with two
 * of six filled then reads as two facts and a footnote, not as four absences.
 */
function Facts({ icon: Icon, title, fields, children, note }) {
  const known = fields.filter(([, value]) => value);
  const missing = fields.filter(([, value]) => !value).map(([label]) => label.toLowerCase());

  return (
    <section className="profile-card">
      <header>
        <span className="profile-card-icon"><Icon size={13} /></span>
        <h2>{title}</h2>
      </header>

      {known.length > 0 && (
        <dl className="profile-facts">
          {known.map(([label, value, extra]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value}
                {extra ? <em>{extra}</em> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {children}

      {missing.length > 0 && (
        <p className="profile-missing">
          Not on file: {missing.join(', ')}
          {note ? ` — ${note}` : ''}
        </p>
      )}
    </section>
  );
}

/**
 * What company property this person is holding.
 *
 * `asset.read` was never granted to the employee role, so the laptop signed out in somebody's name
 * was invisible to the one person responsible for returning it. 0088 grants it at self scope, and
 * assets_select passes the row's employee_id, so this resolves to their own kit and nothing else.
 */
function MyAssets({ employeeId }) {
  const { data: assets = [], isLoading, error } = useEmployeeAssets(employeeId);

  if (isLoading) {
    return <p className="profile-note"><Loader2 size={12} className="animate-spin" /> Loading…</p>;
  }
  if (error) return <p className="profile-error" role="alert">{error.message}</p>;
  if (!assets.length) return <p className="profile-note">Nothing is signed out to you.</p>;

  return (
    <ul className="profile-assets">
      {assets.map((a) => (
        <li key={a.id}>
          <span className="profile-asset-icon"><Package size={14} /></span>
          <span className="profile-asset-copy">
            <strong>{a.name}</strong>
            <em>
              {[a.category, [a.make, a.model].filter(Boolean).join(' '), a.asset_code, a.serial]
                .filter(Boolean)
                .join(' · ') || '—'}
            </em>
          </span>
          {/* The condition it was signed out in — what a return is measured against. */}
          <span className="profile-asset-state">{a.condition || a.status}</span>
        </li>
      ))}
    </ul>
  );
}

function ProfileLoading() {
  return (
    <div className="page-shell user-profile animate-fade-in" aria-label="Loading profile">
      <div className="profile-hero skeleton" />
      <div className="profile-grid">
        <div className="profile-card skeleton" />
        <div className="profile-card skeleton" />
      </div>
    </div>
  );
}

export default function UserProfile({ roleLabel = 'Employee', onOpenSettings }) {
  const { employee, user } = useAuth();
  const linkedEmployee = Boolean(employee?.id);
  // The DETAIL row, not the roster. This used to find its record in useEmployees(), whose list
  // select stopped carrying the personal, emergency and statutory columns — so every field this
  // page exists to show ("Personal email", "Blood group", the emergency contact…) rendered
  // "Not on file" even when HR had filled it in, and told the reader to go ask HR for data HR
  // had already recorded. One person, one row: fetch exactly that.
  const employeeQuery = useEmployee(employee?.id, { enabled: linkedEmployee });
  const record = employeeQuery.data || employee || null;
  const { data: avatars = {} } = useEmployeeAvatars(record?.id ? [record.id] : []);
  const updateProfile = useUpdateMyProfile();

  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPhone(record?.phone || '');
  }, [record?.phone]);

  const displayName =
    record?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const workEmail = record?.email || user?.email;

  // The four things people actually read off this page — quoted to HR, to payroll, onto a form.
  const strip = useMemo(() => ([
    ['Employee code', record?.employee_code],
    ['Department', record?.department?.name],
    ['Branch', record?.branch?.name || record?.branch?.code],
    ['Joined', formatDate(record?.join_date), tenureFrom(record?.join_date)],
  ]), [record]);

  if (linkedEmployee && employeeQuery.isLoading && !employeeQuery.data) return <ProfileLoading />;

  const phoneChanged = phone.trim() !== (record?.phone || '');
  const savePhone = (event) => {
    event?.preventDefault();
    if (!phoneChanged || updateProfile.isPending) return;
    updateProfile.mutate({ phone: phone.trim() }, {
      onSuccess: () => {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2400);
      },
    });
  };

  return (
    <div className="page-shell user-profile animate-fade-in">
      <header className="profile-hero">
        <div className="profile-avatar">
          {avatars[record?.id] ? (
            <img src={avatars[record.id]} alt={`Photograph of ${displayName}`} />
          ) : (
            initials(displayName)
          )}
        </div>

        <div className="profile-identity">
          <h1>{displayName}</h1>
          <p>{record?.designation?.title || roleLabel}</p>
          <div className="profile-chips">
            {record?.status && (
              <span className={record.status === 'Active' ? 'is-active' : ''}>
                <BadgeCheck size={11} /> {record.status}
              </span>
            )}
            <span>{roleLabel}</span>
          </div>
        </div>

        <button type="button" className="profile-settings" onClick={onOpenSettings}>
          <Settings size={14} /> <span>Settings</span>
        </button>
      </header>

      {/* Given their own row so they are answerable at a glance rather than found inside a list. */}
      {record && (
        <div className="profile-strip">
          {strip.map(([label, value, extra]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{value || '—'}</strong>
              {extra ? <em>{extra}</em> : null}
            </div>
          ))}
        </div>
      )}

      {employeeQuery.error && (
        <div className="profile-alert" role="alert">
          <AlertTriangle size={15} />
          <span>Some details could not be loaded. Basic account information is shown.</span>
        </div>
      )}

      {!linkedEmployee && (
        <div className="profile-alert is-info">
          <ShieldCheck size={15} />
          <span>This administrator login is not linked to an employee record.</span>
        </div>
      )}

      <div className="profile-grid">
        {/* Yours to change. update_my_profile accepts a phone number and nothing else, so this is
            the whole of what the page can offer as an action — worth saying plainly rather than
            leaving people to work it out by finding no other pencil. */}
        {linkedEmployee && (
          <section className="profile-card is-editable">
            <header>
              <span className="profile-card-icon"><Phone size={13} /></span>
              <h2>Your phone number</h2>
            </header>
            <form className="profile-phone" onSubmit={savePhone}>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="Not recorded"
                aria-label="Your phone number"
              />
              <button type="submit" disabled={!phoneChanged || updateProfile.isPending}>
                {updateProfile.isPending
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Check size={13} />}
                Save
              </button>
            </form>
            {updateProfile.isError && <p className="profile-error">{updateProfile.error?.message}</p>}
            {saved && <p className="profile-saved"><Check size={12} /> Phone updated</p>}
            <p className="profile-note">
              The only detail you can change here. Everything else is maintained by HR — ask them if
              something below is wrong.
            </p>
          </section>
        )}

        <Facts
          icon={Mail}
          title="Contact"
          fields={[
            ['Work email', workEmail ? <a href={`mailto:${workEmail}`}>{workEmail}</a> : null],
            ['Personal email', record?.personal_email
              ? <a href={`mailto:${record.personal_email}`}>{record.personal_email}</a> : null],
            ['Address', record?.address],
          ]}
        />

        {record && (
          <Facts
            icon={BriefcaseBusiness}
            title="Placement"
            fields={[
              ['Company', record.entity?.name],
              ['Designation', record.designation?.title],
              ['Department', record.department?.name],
              ['Branch', record.branch?.name || record.branch?.code],
            ]}
          />
        )}

        {/* Ahead of Personal on purpose: the section most worth checking is right, and the one whose
            being wrong costs the most. */}
        {record && (
          <Facts
            icon={HeartPulse}
            title="Emergency contact"
            fields={[
              ['Name', record.emergency_name],
              ['Phone', record.emergency_phone
                ? <a href={`tel:${record.emergency_phone}`}>{record.emergency_phone}</a> : null],
              ['Relationship', record.emergency_relation],
            ]}
            note="ask HR to add them"
          />
        )}

        {record && (
          <Facts
            icon={UserRound}
            title="Personal"
            fields={[
              ['Date of birth', formatDate(record.date_of_birth)],
              ['Gender', record.gender],
              ["Father's name", record.father_name],
              ["Mother's name", record.mother_name],
              ['Blood group', record.blood_group],
            ]}
          />
        )}

        <Facts
          icon={ShieldCheck}
          title="Account"
          fields={[
            ['Login email', user?.email],
            ['Access role', roleLabel],
          ]}
        >
          <button type="button" className="profile-inline-link" onClick={onOpenSettings}>
            <Settings size={13} /> Password and display settings
          </button>
        </Facts>

        {record?.id && (
          <Facts icon={Package} title="Assets you hold" fields={[]}>
            <MyAssets employeeId={record.id} />
          </Facts>
        )}
      </div>
    </div>
  );
}
