// The signed-in person's profile: identity and key facts, contact details, then HR information.
// Only the phone number is self-service; update_my_profile accepts exactly that field.
import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BriefcaseBusiness,
  Check,
  HeartPulse,
  Loader2,
  Mail,
  Menu,
  Package,
  Settings,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useEmployeeAvatars } from '../data/documents';
import { useEmployee } from '../data/employees';
import { useEmployeeAssets } from '../data/assets';
import { useUpdateMyProfile } from '../data/settings';
import './profileMenu.css';

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
function Facts({ icon: Icon, title, fields, children, note, className = '' }) {
  const known = fields.filter(([, value]) => value);
  const missing = fields.filter(([, value]) => !value).map(([label]) => label.toLowerCase());

  return (
    <section className={`profile-card ${className}`}>
      <header>
        <span className="profile-card-icon"><Icon size={16} aria-hidden="true" /></span>
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

      {missing.length > 0 && (
        <p className="profile-missing">
          Not on file: {missing.join(', ')}
          {note ? ` — ${note}` : ''}
        </p>
      )}

      {children}
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

// Keep the navigation entry outside the employee-data boundary. An unlinked login or a slow
// profile request must still be able to reach its settings and the rest of the application.
export function ProfileMenuHeader({ onOpenMenu, menuOpen = false }) {
  return (
    <header className="profile-mobile-topbar">
      <span className="profile-mobile-title">Profile</span>
      <button
        type="button"
        className="profile-menu-trigger"
        onClick={onOpenMenu}
        aria-label="Open profile menu"
        aria-controls="mobile-navigation"
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        title="Menu and settings"
      >
        <Menu size={23} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </header>
  );
}

function ProfileLoading({ onOpenMenu, menuOpen }) {
  return (
    <div className="page-shell user-profile animate-fade-in" aria-label="Loading profile">
      <ProfileMenuHeader onOpenMenu={onOpenMenu} menuOpen={menuOpen} />
      <div className="profile-hero skeleton" />
      <div className="profile-layout" aria-hidden="true">
        <div className="profile-card profile-contact skeleton" />
        <div className="profile-card profile-details skeleton" />
        <div className="profile-card profile-account skeleton" />
      </div>
    </div>
  );
}

export default function UserProfile({ roleLabel = 'Employee', onOpenSettings, onOpenMenu = onOpenSettings, menuOpen = false }) {
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
  const phoneId = useId();

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

  if (linkedEmployee && employeeQuery.isLoading && !employeeQuery.data) {
    return <ProfileLoading onOpenMenu={onOpenMenu} menuOpen={menuOpen} />;
  }

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
      <ProfileMenuHeader onOpenMenu={onOpenMenu} menuOpen={menuOpen} />
      <header className="profile-hero">
        <div className="profile-hero-main">
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
                  <BadgeCheck size={12} aria-hidden="true" /> {record.status}
                </span>
              )}
              <span>{roleLabel}</span>
            </div>
          </div>

          {onOpenSettings && <button type="button" className="profile-settings" onClick={onOpenSettings}>
            <Settings size={16} aria-hidden="true" /> <span>Settings</span>
          </button>}
        </div>

        {record && (
          <dl className="profile-strip" aria-label="Employment summary">
            {strip.map(([label, value, extra]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}{extra ? <em>{extra} with us</em> : null}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>

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

      <div className={`profile-layout${record ? '' : ' is-unlinked'}`}>
        <Facts
          icon={Mail}
          title="Contact details"
          className="profile-contact"
          fields={[
            ['Work email', workEmail ? <a key="work-email" href={`mailto:${workEmail}`}>{workEmail}</a> : null],
            ['Personal email', record?.personal_email
              ? <a key="personal-email" href={`mailto:${record.personal_email}`}>{record.personal_email}</a> : null],
            ['Address', record?.address],
          ]}
        >
          {linkedEmployee && (
            <form className="profile-phone-section" onSubmit={savePhone}>
              <div className="profile-phone-label">
                <label htmlFor={phoneId}>Your phone number</label>
                <span className="profile-editable-label">Editable</span>
              </div>
              <div className="profile-phone">
                <input
                  id={phoneId}
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="Add phone number"
                  aria-describedby={`${phoneId}-hint`}
                  disabled={updateProfile.isPending}
                />
                <button type="submit" disabled={!phoneChanged || updateProfile.isPending}>
                  {updateProfile.isPending
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <Check size={14} aria-hidden="true" />}
                  Save
                </button>
              </div>
              {updateProfile.isError && <p className="profile-error" role="alert">{updateProfile.error?.message}</p>}
              {saved && <p className="profile-saved" role="status"><Check size={12} aria-hidden="true" /> Phone updated</p>}
              <p className="profile-note" id={`${phoneId}-hint`}>
                You can update your phone number here. Contact HR to change other details.
              </p>
            </form>
          )}
        </Facts>

        {record && (
          <div className="profile-details">
            <Facts
              icon={BriefcaseBusiness}
              title="Employment"
              className="profile-employment"
              fields={[
                ['Company', record.entity?.name],
                ['Designation', record.designation?.title],
                ['Department', record.department?.name],
                ['Branch', record.branch?.name || record.branch?.code],
              ]}
            >
              <p className="profile-details-note">
                These details are maintained by HR. Contact HR to make a correction.
              </p>
            </Facts>

            <div className="profile-details-pair">
              <Facts
                icon={UserRound}
                title="Personal details"
                fields={[
                  ['Date of birth', formatDate(record.date_of_birth)],
                  ['Gender', record.gender],
                  ["Father's name", record.father_name],
                  ["Mother's name", record.mother_name],
                  ['Blood group', record.blood_group],
                ]}
              />

              <Facts
                icon={HeartPulse}
                title="Emergency contact"
                fields={[
                  ['Name', record.emergency_name],
                  ['Phone', record.emergency_phone
                    ? <a key="emergency-phone" href={`tel:${record.emergency_phone}`}>{record.emergency_phone}</a> : null],
                  ['Relationship', record.emergency_relation],
                ]}
                note="ask HR to add them"
              />
            </div>

            {record.id && (
              <Facts icon={Package} title="Assets you hold" fields={[]}>
                <MyAssets employeeId={record.id} />
              </Facts>
            )}
          </div>
        )}

        <Facts
          icon={ShieldCheck}
          title="Account"
          className="profile-account"
          fields={[
            ['Login email', user?.email],
            ['Access role', roleLabel],
          ]}
        >
          {onOpenSettings && <button type="button" className="profile-inline-link" onClick={onOpenSettings}>
            <Settings size={14} aria-hidden="true" /> Password and display settings
          </button>}
        </Facts>
      </div>
    </div>
  );
}
