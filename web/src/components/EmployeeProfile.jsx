// Employee profile — the detail screen shown in place of the Directory list (master-detail).
//
// Everything the record holds is on one scroll. The four tabs this replaced hid three quarters of
// a person behind a click, which is the wrong trade for a screen people open to answer one small
// question: what is their PAN, when did they join, which branch. A sticky rail carries the summary,
// the quick actions, and a section index, so a long page stays one jump away from any answer.
// Shows only real record data — nothing estimated or mocked.
import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Pencil, Mail, Phone, Copy, Check, Calendar, Building2, MapPin, Layers,
  Briefcase, Award, ShieldAlert, ExternalLink, KeyRound, UserRound, HeartPulse,
  Landmark, IdCard, Paperclip, FileText, Download, Eye, Loader2, AlertTriangle, Boxes, Package,
  ChevronRight,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEmployee } from '../data/employees';
import { useEmployeeDocuments, useDocumentLink, useEmployeeAvatars, fileSize } from '../data/documents';
import { useEmployeeAssets } from '../data/assets';
import { useSalaryStructures } from '../data/payroll';
import { todayIso } from '../data/attendance';
import { currentSectionId } from '../lib/sectionSpy';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';

const initials = (name) =>
  (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase() || '?';

const statusClass = (status) =>
  status === 'Active'
    ? 'is-active'
    : status === 'On Leave'
    ? 'is-leave'
    : status === 'Probation'
    ? 'is-probation'
    : 'is-inactive';

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// '3y 4m' since join_date (null when unknown / in the future).
const tenureOf = (join) => {
  if (!join) return null;
  const start = new Date(join);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y > 0 ? `${y}y ${m}m` : `${m}m`;
};

function Field({ label, value, mono }) {
  const empty = !value;
  return (
    <div className={`emp-field${empty ? ' is-empty' : ''}`}>
      <span>{label}</span>
      <strong className={mono ? 'is-mono' : undefined}>{value || 'Not recorded'}</strong>
    </div>
  );
}

// The files filed against this person. Every one lives in a private bucket, so both actions go
// through a freshly signed URL — view opens it inline, download asks for it under the name it was
// uploaded with. The link is minted per click and never held, so it cannot outlive the permission
// that produced it.
function DocumentsSection({ employeeId }) {
  const { data: docs = [], isLoading, error } = useEmployeeDocuments(employeeId);
  const link = useDocumentLink();
  const [busy, setBusy] = useState(null);

  const openFile = async (doc, download) => {
    setBusy(`${doc.id}:${download ? 'download' : 'view'}`);
    try {
      const href = await link.mutateAsync({ doc, download });
      // An anchor rather than window.open: this runs after an await, and a popup opened outside a
      // live gesture is what phone browsers block.
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* surfaced under the list */
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return <p className="emp-doc-note"><Loader2 size={13} className="animate-spin" /> Loading documents…</p>;
  }

  if (error) {
    return (
      <div className="emp-doc-error" role="alert">
        <AlertTriangle size={14} /> <span>{error.message}</span>
      </div>
    );
  }

  if (!docs.length) {
    return (
      <div className="emp-empty">
        <Paperclip size={20} />
        <p>No documents are filed against this person yet. Add them from the employee form or the Documents screen.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="emp-doc-list">
        {docs.map((doc) => {
          const meta = [doc.category, doc.file_name, fileSize(doc.size_bytes)].filter(Boolean).join(' · ');
          const hasFile = Boolean(doc.storage_path || doc.url);
          return (
            <li key={doc.id} className="emp-doc">
              <span className="emp-doc-icon"><FileText size={15} /></span>
              <span className="emp-doc-copy">
                <strong>{doc.title}</strong>
                <em>{meta || 'No file attached'}</em>
              </span>
              <span className="emp-doc-actions">
                <button
                  type="button"
                  onClick={() => openFile(doc, false)}
                  disabled={!hasFile || busy === `${doc.id}:view`}
                  title={hasFile ? 'View file' : 'No file attached'}
                >
                  {busy === `${doc.id}:view` ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                  View
                </button>
                <button
                  type="button"
                  onClick={() => openFile(doc, true)}
                  disabled={!hasFile || busy === `${doc.id}:download`}
                  title={hasFile ? 'Download file' : 'No file attached'}
                >
                  {busy === `${doc.id}:download` ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  Download
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {link.error && (
        <div className="emp-doc-error" role="alert">
          <AlertTriangle size={14} /> <span>{link.error.message}</span>
        </div>
      )}
    </>
  );
}

// What company property this person is holding right now. The register is the authority; this is
// the same question asked from the other end, and it is the one exit clearance actually needs.
//
// Each row opens that item's record in the asset register. Reading "Dell Latitude 5420" here and
// then having to go to Assets and search for it again is the same lookup done twice by hand; the
// register's detail page is where the serial, the warranty and the custody history already live.
function EmployeeAssetsSection({ employeeId, onOpenAsset }) {
  const { data: assets = [], isLoading, error } = useEmployeeAssets(employeeId);

  if (isLoading) {
    return <p className="emp-doc-note"><Loader2 size={13} className="animate-spin" /> Loading assets…</p>;
  }
  if (error) {
    return (
      <div className="emp-doc-error" role="alert">
        <AlertTriangle size={14} /> <span>{error.message}</span>
      </div>
    );
  }
  if (!assets.length) {
    return (
      <div className="emp-empty">
        <Boxes size={20} />
        <p>Nothing is allocated to this person. Company property they hold will appear here.</p>
      </div>
    );
  }

  return (
    <ul className="emp-doc-list">
      {assets.map((a) => (
        <li key={a.id} className={`emp-doc${onOpenAsset ? ' is-linked' : ''}`}>
          <span className="emp-doc-icon"><Package size={15} /></span>
          <span className="emp-doc-copy">
            {onOpenAsset ? (
              <button type="button" className="emp-doc-link" onClick={() => onOpenAsset(a.id)}>
                {a.name}
                <ChevronRight size={13} aria-hidden="true" />
                <span className="sr-only">Open this asset in the register</span>
              </button>
            ) : (
              <strong>{a.name}</strong>
            )}
            <em>
              {[a.category, [a.make, a.model].filter(Boolean).join(' '), a.asset_code, a.serial]
                .filter(Boolean).join(' · ')}
            </em>
          </span>
          <span className="emp-doc-actions">
            <span className={`asset-status ${a.status === 'Allocated' ? 'is-allocated' : 'is-repair'}`}>
              {a.condition || a.status}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function OrgNode({ icon: Icon, label, value, last }) {
  return (
    <div className={`emp-org-node${last ? ' is-last' : ''}`}>
      <span className="emp-org-mark">
        <Icon size={13} />
      </span>
      <span className="emp-org-label">{label}</span>
      <strong className="emp-org-value">{value || 'Not recorded'}</strong>
    </div>
  );
}

export default function ProfileDrawer({ emp: initialEmp, onClose, onEdit, onGrantAccess }) {
  const [copied, setCopied] = useState(false);
  const [activeSection, setActiveSection] = useState('contact');
  const { canAny, can, canBeyondSelf } = usePermissions();
  const { employee: me } = useAuth();
  const navigate = useNavigate();

  /**
   * Salary, bank account and statutory IDs are the most sensitive fields in the record, and they
   * were rendered to anyone who could open a directory entry — no gate at all. Nothing about
   * holding employee.read says you may read someone's PAN.
   *
   * The bar is the one the database already sets: salary_structures is readable by a
   * payroll.manage holder over that person, or by the person themselves (migration 0040). Aadhaar
   * carries an explicit column comment saying it is not for list views. So: payroll authority over
   * this specific record, or it is your own record.
   */
  const empScope = {
    entityId: initialEmp.entity_id ?? null,
    zoneId: initialEmp.zone_id ?? null,
    branchId: initialEmp.branch_id ?? null,
    deptId: initialEmp.department_id ?? null,
    employeeId: initialEmp.id ?? null,
  };
  const isOwnRecord = Boolean(me?.id) && me.id === initialEmp.id;
  const canSeePay = isOwnRecord || can('payroll.manage', empScope);
  const canSeePrivate = canSeePay || can('employee.update', empScope);
  const detailQuery = useEmployee(initialEmp.id, { enabled: canSeePrivate && Boolean(initialEmp.id) });
  const emp = detailQuery.data ? { ...initialEmp, ...detailQuery.data } : initialEmp;
  // Their photograph, if one has been filed. Falls back to initials, which is what everyone
  // without a photo has always had.
  const { data: avatars = {} } = useEmployeeAvatars([emp.id]);
  const avatarUrl = avatars[emp.id];

  // Escape closes the profile (parity with the app's other overlays).
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyEmail = () => {
    if (!emp.email) return;
    navigator.clipboard.writeText(emp.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tenure = tenureOf(emp.join_date);
  const branchName = emp.branch?.name || emp.branch?.code || 'Entity-wide';
  const designation = emp.designation?.title || 'No designation';

  const completeness = [
    emp.full_name,
    emp.employee_code,
    emp.email,
    emp.phone,
    emp.join_date,
    emp.entity?.name,
    emp.branch?.name || emp.branch?.code,
    emp.department?.name,
    emp.designation?.title,
    emp.date_of_birth,
    emp.pan,
    emp.bank_account,
  ].filter(Boolean).length;
  const completenessPct = Math.round((completeness / 12) * 100);

  /**
   * Compensation — the salary row payroll will actually pay against.
   *
   * This used to read `emp.salary`, a jsonb column on the employee that nothing in the application
   * has ever written, so the section said "not recorded" for everybody no matter how carefully
   * payroll had been set up. The real record is salary_structures: monthly basic and gross,
   * effective-dated, newest first, and readable under exactly the bar this page already applies.
   */
  const payQuery = useSalaryStructures(emp.id, { enabled: canSeePay && Boolean(emp.id) });
  const salary = payQuery.data?.find((row) => !row.effective_from || row.effective_from <= todayIso()) ?? null;
  const grossMonthly = salary?.gross != null ? Number(salary.gross) : null;
  const baseMonthly = salary?.basic != null ? Number(salary.basic) : null;
  const grossAnnual = grossMonthly != null ? grossMonthly * 12 : null;
  const basePct =
    grossMonthly > 0 && baseMonthly > 0
      ? Math.min(100, Math.round((baseMonthly / grossMonthly) * 100))
      : null;

  const sections = [
    {
      id: 'contact',
      label: 'Contact',
      icon: Mail,
      body: (
        <div className="emp-contact-list">
          <div className="emp-contact">
            <Mail size={14} />
            <span>{emp.email || 'No office email on record'}</span>
            {emp.email && (
              <div className="emp-contact-actions">
                <button type="button" onClick={copyEmail} title="Copy email" aria-label="Copy email address">
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <a href={`mailto:${emp.email}`} title="Send email" aria-label="Send email">
                  <ExternalLink size={12} />
                </a>
              </div>
            )}
          </div>
          <div className="emp-contact">
            <Phone size={14} />
            <span>{emp.phone || 'No phone on record'}</span>
            {emp.phone && (
              <div className="emp-contact-actions">
                <a href={`tel:${emp.phone}`} title="Call" aria-label="Call employee">
                  <Phone size={12} />
                </a>
              </div>
            )}
          </div>
          {/* The address above is the office one — the company's channel, and the one the login
              defaults to. This is the one that still reaches them after they hand that back. */}
          {canSeePrivate && (
            <div className="emp-field-grid emp-contact-extra">
              <Field label="Personal email" value={emp.personal_email} />
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'employment',
      label: 'Employment',
      icon: Calendar,
      body: (
        <div className="emp-field-grid">
          <Field label="Joined on" value={fmtDate(emp.join_date)} />
          <Field label="Tenure" value={tenure} />
          <Field label="Employee code" value={emp.employee_code} mono />
          <Field label="Status" value={emp.status} />
        </div>
      ),
    },
    {
      id: 'organization',
      label: 'Organization',
      icon: Building2,
      body: (
        <>
          <div className="emp-org">
            <OrgNode icon={Building2} label="Entity" value={emp.entity?.name} />
            <OrgNode icon={MapPin} label="Location / Branch" value={emp.branch ? emp.branch.name || emp.branch.code : 'Entity-wide'} />
            <OrgNode icon={Layers} label="Department" value={emp.department?.name} />
            <OrgNode icon={Briefcase} label="Designation" value={emp.designation?.title} last />
          </div>
          {/* Grade is the one thing the old Role tab held that the path above does not. Its other
              two fields repeated the designation and the status, which are already on this page. */}
          <div className="emp-field-grid emp-org-extra">
            <Field label="Grade level" value={emp.designation?.grade} mono />
          </div>
        </>
      ),
    },
    {
      id: 'personal',
      sensitive: 'private',
      label: 'Personal',
      icon: UserRound,
      body: (
        <div className="emp-field-grid">
          <Field label="Date of birth" value={fmtDate(emp.date_of_birth)} />
          <Field label="Gender" value={emp.gender} />
          <Field label="Father's name" value={emp.father_name} />
          <Field label="Mother's name" value={emp.mother_name} />
          <Field label="Blood group" value={emp.blood_group} mono />
          <Field label="Address" value={emp.address} />
        </div>
      ),
    },
    {
      id: 'statutory',
      sensitive: 'private',
      label: 'Statutory IDs',
      icon: IdCard,
      body: (
        <div className="emp-field-grid">
          <Field label="PAN" value={emp.pan} mono />
          <Field label="Aadhaar" value={emp.aadhaar} mono />
          <Field label="UAN" value={emp.uan} mono />
          <Field label="PF number" value={emp.pf_number} mono />
          <Field label="ESI" value={emp.esi_number} mono />
        </div>
      ),
    },
    {
      id: 'emergency',
      sensitive: 'private',
      label: 'Emergency',
      icon: HeartPulse,
      body: (
        <div className="emp-field-grid">
          <Field label="Name" value={emp.emergency_name} />
          <Field label="Phone" value={emp.emergency_phone} mono />
          <Field label="Relation" value={emp.emergency_relation} />
        </div>
      ),
    },
    {
      id: 'compensation',
      sensitive: 'pay',
      label: 'Compensation',
      icon: Award,
      body: payQuery.isLoading ? (
        <p className="emp-doc-note"><Loader2 size={13} className="animate-spin" /> Loading compensation…</p>
      ) : salary ? (
        <div className="emp-pay">
          {grossAnnual != null && (
            <div className="emp-pay-headline">
              <span>Annual gross</span>
              <strong>{inr(grossAnnual)}</strong>
            </div>
          )}

          {basePct != null && (
            <div className="emp-pay-split">
              <div className="emp-pay-bar">
                <i style={{ width: `${basePct}%` }} className="is-base" title={`Basic: ${basePct}%`} />
                <i style={{ width: `${100 - basePct}%` }} className="is-other" title={`Allowances: ${100 - basePct}%`} />
              </div>
              <div className="emp-pay-legend">
                <span><i className="is-base" /> Basic ({basePct}%)</span>
                <span><i className="is-other" /> Allowances ({100 - basePct}%)</span>
              </div>
            </div>
          )}

          <div className="emp-field-grid">
            {grossMonthly != null && <Field label="Monthly gross" value={inr(grossMonthly)} mono />}
            {baseMonthly != null && <Field label="Monthly basic" value={inr(baseMonthly)} mono />}
            <Field label="Effective from" value={fmtDate(salary.effective_from)} />
          </div>

          <p className="emp-note">
            The salary structure payroll runs against. Revisions are effective-dated — this is the
            one in force. Component breakdowns beyond basic and gross are managed in Payroll.
          </p>
        </div>
      ) : (
        <div className="emp-empty">
          <ShieldAlert size={20} />
          <p>No salary structure is on file for this person. Set one from Payroll, or from the
            Compensation block on their employee form.</p>
        </div>
      ),
    },
    {
      id: 'banking',
      sensitive: 'private',
      label: 'Banking',
      icon: Landmark,
      body: (
        <div className="emp-field-grid">
          <Field label="Bank" value={emp.bank_name} />
          <Field label="Account" value={emp.bank_account} mono />
          <Field label="IFSC" value={emp.bank_ifsc} mono />
          <Field label="Account holder" value={emp.account_holder} />
        </div>
      ),
    },
  // Salary, bank details and statutory IDs only for payroll authority over this person, or
  // for the person themselves. Filtered here rather than gated at each render site, so the
  // rail's section index, the scroll-spy and the jump links all agree about what is on the page.
  ].filter((s) => !s.sensitive || (s.sensitive === 'pay' ? canSeePay : canSeePrivate));

  // Both of these carry their own permission. Someone who may see a person but not their file
  // cabinet gets no section at all, rather than an empty one reading as "nothing was uploaded".
  if (canAny('asset.read')) {
    // The register screen itself is gated on asset.read BEYOND yourself (App.jsx), so somebody
    // whose only grant is their own kit still sees the list here but must not be handed a link
    // into a screen that would turn them away.
    const canOpenRegister = canBeyondSelf('asset.read');
    sections.push({
      id: 'assets',
      className: 'cursor-pointer',
      label: 'Assets held',
      icon: Boxes,
      body: (
        <EmployeeAssetsSection
          employeeId={emp.id}
          onOpenAsset={canOpenRegister ? (assetId) => navigate(`/assets/${assetId}`) : null}
        />
      ),
    });
  }

  if (canAny('document.read')) {
    sections.push({
      id: 'documents',
      label: 'Documents',
      icon: Paperclip,
      body: <DocumentsSection employeeId={emp.id} />,
    });
  }
  const sectionIds = sections.map((s) => s.id).join('|');

  // A click owns the highlight until its smooth scroll finishes. Without this the spy below fights
  // the animation — it reports every section the page flies past, so the rail flickers through
  // four entries and lands whichever one the scroll happened to stop nearest.
  const jumpLock = useRef(0);

  // Which section the reader is actually looking at. The rule itself, and why it replaced an
  // IntersectionObserver, is in lib/sectionSpy.js — this only measures and reports.
  useEffect(() => {
    const nodes = sectionIds
      .split('|')
      .map((id) => document.getElementById(`emp-sec-${id}`))
      .filter(Boolean);
    if (!nodes.length) return undefined;

    const scroller = nodes[0].closest('.app-main') ?? document.scrollingElement ?? document.body;
    let frame = 0;

    const measure = () => {
      frame = 0;
      if (Date.now() < jumpLock.current) return;
      const box = scroller.getBoundingClientRect?.() ?? { top: 0 };
      const next = currentSectionId(
        nodes.map((node) => ({ id: node.dataset.section, top: node.getBoundingClientRect().top })),
        {
          // A quarter of the way down the scroller: low enough that a section reads as "arrived"
          // once its heading is comfortably on screen, high enough that two never share the line.
          line: box.top + scroller.clientHeight * 0.25,
          atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
        },
      );
      if (next) setActiveSection(next);
    };

    // Coalesce to one measurement per frame: scroll fires far faster than the rail can change.
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [sectionIds]);

  const jumpTo = (id) => {
    const el = document.getElementById(`emp-sec-${id}`);
    if (!el) return;
    // Answer the click immediately rather than waiting to be told by the scroll — including for
    // the last section, which the page may not be able to scroll far enough to reach.
    setActiveSection(id);
    jumpLock.current = Date.now() + 700;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // And move the keyboard focus with the view. Scrolling a sighted reader to a section while
    // leaving the caret back in the rail means the next Tab carries on from the wrong place, and a
    // screen reader is never told the page moved at all.
    el.focus({ preventScroll: true });
  };

  return (
    <section className="emp-profile animate-fade-in">
      <header className="emp-hero">
        <div className="emp-hero-bar">
          <button type="button" onClick={onClose} className="emp-back">
            <ArrowLeft size={14} /> Directory
          </button>
          <div className="emp-hero-actions">
            {emp.email && (
              <a href={`mailto:${emp.email}`} title="Send email" aria-label="Send email">
                <Mail size={14} />
              </a>
            )}
            {emp.phone && (
              <a href={`tel:${emp.phone}`} title="Call employee" aria-label="Call employee">
                <Phone size={14} />
              </a>
            )}
            {onGrantAccess && (
              <button type="button" onClick={onGrantAccess} title="Give app access" aria-label="Give app access">
                <KeyRound size={14} />
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={onEdit} title="Edit employee" aria-label="Edit employee">
                <Pencil size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="emp-hero-id">
          <div className="emp-avatar">
            {avatarUrl
              ? <img src={avatarUrl} alt={`Photograph of ${emp.full_name}`} />
              : initials(emp.full_name)}
          </div>
          <div className="emp-hero-text">
            <h1>{emp.full_name}</h1>
            <p>
              {designation}
              {emp.department?.name ? ` · ${emp.department.name}` : ''}
              {branchName ? ` · ${branchName}` : ''}
            </p>
            <div className="emp-hero-chips">
              <span className={`emp-status ${statusClass(emp.status)}`}>{emp.status}</span>
              <span>{emp.employee_code || 'No code'}</span>
              {emp.entity?.code && <span>{emp.entity.code}</span>}
            </div>
          </div>
        </div>
      </header>

      <div className="emp-layout">
        <div className="emp-main">
          {sections.map((sec) => {
            const Icon = sec.icon;
            return (
              <article
                key={sec.id}
                id={`emp-sec-${sec.id}`}
                data-section={sec.id}
                // -1 so jumpTo can put the caret here without adding a Tab stop of its own.
                tabIndex={-1}
                aria-labelledby={`emp-sec-${sec.id}-head`}
                className="emp-section"
              >
                <h2 className="emp-section-head" id={`emp-sec-${sec.id}-head`}>
                  <Icon size={12} /> {sec.label}
                </h2>
                {sec.body}
              </article>
            );
          })}
        </div>

        <aside className="emp-rail">
          <div className="emp-rail-card emp-glance">
            <span className="emp-rail-title">At a glance</span>
            <div className="emp-glance-grid">
              <div>
                <strong>{tenure || '—'}</strong>
                <small>Tenure</small>
              </div>
              <div>
                <strong>{emp.designation?.grade || '—'}</strong>
                <small>Grade</small>
              </div>
              <div className="emp-glance-wide">
                <strong>{branchName}</strong>
                <small>Branch</small>
              </div>
            </div>

            <div className="emp-complete">
              <div className="emp-complete-top">
                <span>Profile complete</span>
                <strong>{completenessPct}%</strong>
              </div>
              <div className="emp-complete-bar">
                <i style={{ width: `${completenessPct}%` }} />
              </div>
              <small>{completeness} of 12 key fields recorded</small>
            </div>
          </div>

          <nav className="emp-rail-card emp-rail-nav" aria-label="Profile sections">
            <span className="emp-rail-title">Sections</span>
            {sections.map((sec) => {
              const Icon = sec.icon;
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => jumpTo(sec.id)}
                  className={activeSection === sec.id ? 'is-active' : undefined}
                  aria-current={activeSection === sec.id ? 'true' : undefined}
                >
                  <Icon size={13} /> {sec.label}
                </button>
              );
            })}
          </nav>

          {(onEdit || onGrantAccess) && (
            <div className="emp-rail-card emp-rail-actions">
              <span className="emp-rail-title">Actions</span>
              {onEdit && (
                <button type="button" onClick={onEdit}>
                  <Pencil size={13} /> Edit profile
                </button>
              )}
              {onGrantAccess && (
                <button type="button" onClick={onGrantAccess}>
                  <KeyRound size={13} /> Give app access
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
