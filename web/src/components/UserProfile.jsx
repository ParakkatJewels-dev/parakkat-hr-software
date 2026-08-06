import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  HeartPulse,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Settings,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useEmployeeAvatars } from '../data/documents';
import { useEmployees } from '../data/employees';
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
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const tenureFrom = (value) => {
  if (!value) return null;
  const joined = new Date(`${value}T00:00:00`);
  if (Number.isNaN(joined.getTime())) return null;
  const today = new Date();
  let months =
    (today.getFullYear() - joined.getFullYear()) * 12 +
    today.getMonth() -
    joined.getMonth();
  if (today.getDate() < joined.getDate()) months -= 1;
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return years ? `${years}y ${remainingMonths}m` : `${remainingMonths}m`;
};

function ProfileSection({ icon: Icon, title, children }) {
  return (
    <section className="user-profile-section">
      <header>
        <Icon size={15} />
        <h2>{title}</h2>
      </header>
      <div className="user-profile-details">{children}</div>
    </section>
  );
}

function ProfileValue({ icon: Icon, label, value, href, wide = false, children }) {
  return (
    <div className={`user-profile-value${wide ? ' is-wide' : ''}`}>
      <span className="user-profile-value-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="user-profile-value-copy">
        <small>{label}</small>
        {children ||
          (value ? (
            href ? <a href={href}>{value}</a> : <strong>{value}</strong>
          ) : (
            <strong className="is-empty">Not recorded</strong>
          ))}
      </span>
    </div>
  );
}

function ProfileLoading() {
  return (
    <div className="page-shell user-profile animate-fade-in" aria-label="Loading profile">
      <div className="user-profile-hero skeleton" />
      <div className="user-profile-grid">
        <div className="user-profile-section skeleton" />
        <div className="user-profile-section skeleton" />
      </div>
    </div>
  );
}

export default function UserProfile({ roleLabel = 'Employee', onOpenSettings }) {
  const { employee, user } = useAuth();
  const linkedEmployee = Boolean(employee?.id);
  const employeeQuery = useEmployees({ enabled: linkedEmployee });
  const record =
    employeeQuery.data?.find((person) => person.id === employee?.id) || employee || null;
  const { data: avatars = {} } = useEmployeeAvatars(record?.id ? [record.id] : []);
  const updateProfile = useUpdateMyProfile();

  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPhone(record?.phone || '');
  }, [record?.phone]);

  if (linkedEmployee && employeeQuery.isLoading && !employeeQuery.data) {
    return <ProfileLoading />;
  }

  const displayName =
    record?.full_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'User';
  const avatarUrl = record?.id ? avatars[record.id] : null;
  const designation = record?.designation?.title || roleLabel;
  const department = record?.department?.name;
  const branch = record?.branch?.name || record?.branch?.code;
  const joined = formatDate(record?.join_date);
  const tenure = tenureFrom(record?.join_date);
  const phoneChanged = phone.trim() !== (record?.phone || '');

  const completionFields = record
    ? [
        record.full_name,
        record.employee_code,
        record.email || user?.email,
        record.phone,
        record.join_date,
        record.branch?.name || record.branch?.code,
        record.department?.name,
        record.designation?.title,
      ]
    : [];
  const completion = completionFields.length
    ? Math.round((completionFields.filter(Boolean).length / completionFields.length) * 100)
    : null;

  const savePhone = () => {
    if (!phoneChanged || updateProfile.isPending) return;
    updateProfile.mutate(
      { phone: phone.trim() },
      {
        onSuccess: () => {
          setEditingPhone(false);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  return (
    <div className="page-shell user-profile animate-fade-in">
      <header className="user-profile-hero">
        <div className="user-profile-identity">
          <div className="user-profile-avatar">
            {avatarUrl ? (
              <img src={avatarUrl} alt={`Photograph of ${displayName}`} />
            ) : (
              initials(displayName)
            )}
          </div>
          <div className="user-profile-heading">
            <span className="user-profile-eyebrow">My profile</span>
            <h1>{displayName}</h1>
            <p>{[designation, department, branch].filter(Boolean).join(' / ')}</p>
            <div className="user-profile-chips">
              {record?.status && (
                <span className={record.status === 'Active' ? 'is-active' : ''}>
                  <BadgeCheck size={12} /> {record.status}
                </span>
              )}
              {record?.employee_code && <span>{record.employee_code}</span>}
              <span>{roleLabel}</span>
            </div>
          </div>
        </div>

        <div className="user-profile-summary">
          {record && (
            <div className="user-profile-completion">
              <span>
                <small>Profile</small>
                <strong>{completion}%</strong>
              </span>
              <i><b style={{ width: `${completion}%` }} /></i>
            </div>
          )}
          <button type="button" onClick={onOpenSettings}>
            <Settings size={15} />
            <span>Account settings</span>
          </button>
        </div>
      </header>

      {employeeQuery.error && (
        <div className="user-profile-alert" role="alert">
          <AlertTriangle size={15} />
          <span>Some employee details could not be loaded. Basic account information is shown.</span>
        </div>
      )}

      {!linkedEmployee && (
        <div className="user-profile-alert is-info">
          <ShieldCheck size={15} />
          <span>This administrator login is not linked to an employee record.</span>
        </div>
      )}

      <div className="user-profile-grid">
        <div className="user-profile-column">
          <ProfileSection icon={UserRound} title="Contact">
            <ProfileValue
              icon={Mail}
              label="Work email"
              value={record?.email || user?.email}
              href={(record?.email || user?.email) ? `mailto:${record?.email || user?.email}` : null}
            />
            <ProfileValue
              icon={Mail}
              label="Personal email"
              value={record?.personal_email}
              href={record?.personal_email ? `mailto:${record.personal_email}` : null}
            />
            <ProfileValue icon={Phone} label="Phone" value={record?.phone}>
              {linkedEmployee && editingPhone ? (
                <div className="user-profile-phone-editor">
                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') savePhone();
                      if (event.key === 'Escape') {
                        setPhone(record?.phone || '');
                        setEditingPhone(false);
                      }
                    }}
                    autoFocus
                    aria-label="Phone number"
                  />
                  <button
                    type="button"
                    onClick={savePhone}
                    disabled={!phoneChanged || updateProfile.isPending}
                    title="Save phone number"
                    aria-label="Save phone number"
                  >
                    {updateProfile.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Check size={14} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPhone(record?.phone || '');
                      setEditingPhone(false);
                    }}
                    title="Cancel"
                    aria-label="Cancel phone edit"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <span className="user-profile-editable-value">
                  {record?.phone ? <a href={`tel:${record.phone}`}>{record.phone}</a> : <strong className="is-empty">Not recorded</strong>}
                  {linkedEmployee && (
                    <button
                      type="button"
                      onClick={() => setEditingPhone(true)}
                      title="Edit phone number"
                      aria-label="Edit phone number"
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                </span>
              )}
            </ProfileValue>
            {updateProfile.isError && (
              <p className="user-profile-error">{updateProfile.error?.message}</p>
            )}
            {saved && <p className="user-profile-saved"><Check size={12} /> Phone updated</p>}
          </ProfileSection>

          {record && (
            <ProfileSection icon={BriefcaseBusiness} title="Work">
              <ProfileValue icon={Building2} label="Company" value={record.entity?.name} />
              <ProfileValue icon={MapPin} label="Branch" value={branch} />
              <ProfileValue icon={UserRound} label="Department" value={department} />
              <ProfileValue icon={BriefcaseBusiness} label="Designation" value={record.designation?.title} />
              <ProfileValue icon={CalendarDays} label="Joined" value={joined} />
              <ProfileValue icon={CalendarDays} label="Tenure" value={tenure} />
            </ProfileSection>
          )}
        </div>

        <div className="user-profile-column">
          <ProfileSection icon={ShieldCheck} title="Account">
            <ProfileValue icon={Mail} label="Login email" value={user?.email} />
            <ProfileValue icon={BadgeCheck} label="Access role" value={roleLabel} />
            {record?.employee_code && (
              <ProfileValue icon={UserRound} label="Employee code" value={record.employee_code} />
            )}
            <button type="button" className="user-profile-settings-link" onClick={onOpenSettings}>
              <Settings size={14} /> Password and display settings
            </button>
          </ProfileSection>

          {record && (
            <ProfileSection icon={UserRound} title="Personal">
              <ProfileValue icon={CalendarDays} label="Date of birth" value={formatDate(record.date_of_birth)} />
              <ProfileValue icon={UserRound} label="Gender" value={record.gender} />
              <ProfileValue icon={UserRound} label="Father's name" value={record.father_name} />
              <ProfileValue icon={UserRound} label="Mother's name" value={record.mother_name} />
              <ProfileValue icon={BadgeCheck} label="Blood group" value={record.blood_group} />
              <ProfileValue icon={MapPin} label="Address" value={record.address} wide />
            </ProfileSection>
          )}

          {record && (
            <ProfileSection icon={HeartPulse} title="Emergency contact">
              <ProfileValue icon={UserRound} label="Name" value={record.emergency_name} />
              <ProfileValue
                icon={Phone}
                label="Phone"
                value={record.emergency_phone}
                href={record.emergency_phone ? `tel:${record.emergency_phone}` : null}
              />
              <ProfileValue icon={HeartPulse} label="Relationship" value={record.emergency_relation} />
            </ProfileSection>
          )}
        </div>
      </div>
    </div>
  );
}
