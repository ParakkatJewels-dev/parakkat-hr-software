import React, { useState } from 'react';
import { FolderOpen, Plus, ShieldAlert, Loader2, AlertTriangle, FileText, FilePlus } from 'lucide-react';
import { useDocuments, useAddDocument } from '../data/documents';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import FormSection, { Field, FIELD } from './ui/FormSection';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const CATS = ['Policy', 'HR Letter', 'Identity', 'Contract', 'Certificate', 'Other'];

export default function DocumentManagement() {
  const { data: docs = [], isLoading, error } = useDocuments();
  const { canAny } = usePermissions();
  const { employee } = useAuth();
  const add = useAddDocument();
  const canManage = canAny('document.manage');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'Policy', attachSelf: false });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title) return;
    const payload = { title: form.title, category: form.category };
    if (form.attachSelf && employee?.id) payload.employee_id = employee.id;
    try {
      await add.mutateAsync(payload);
      setForm({ title: '', category: 'Policy', attachSelf: false });
      setShowForm(false);
    } catch { /* shown below */ }
  };

  // Paged: this list grows with the business and was rendering every row.
  const pager = usePagination(docs);

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Document Management</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">Policies and documents within your scope.</p>
        </div>
        {canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className={btnClass('primary')}>
            <Plus size={14} /> Add document
          </button>
        )}
      </div>

      {/* Opens directly under the button that summons it — it used to render below the
          whole document list, so on a long list nothing appeared to happen. */}
      {showForm && canManage && (
        <FormSection
          title="Add a document"
          subtitle="Registers the record and where the file lives."
          icon={FilePlus}
          onClose={() => { add.reset(); setShowForm(false); }}
          onSubmit={submit}
          submitLabel="Save document"
          busy={add.isPending}
          error={add.error?.message}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Title" htmlFor="doc-title" required>
              <input
                id="doc-title"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Employee Handbook v5"
                className={FIELD}
              />
            </Field>
            <Field label="Category" htmlFor="doc-cat">
              <select
                id="doc-cat"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={FIELD + ' cursor-pointer'}
              >
                {CATS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          {employee?.id && (
            <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.attachSelf}
                onChange={(e) => setForm({ ...form, attachSelf: e.target.checked })}
                className="accent-[#0ea971] cursor-pointer"
              />
              Attach to my own record (otherwise it is company-wide)
            </label>
          )}
        </FormSection>
      )}

      <div className="premium-card p-5 space-y-4">
        <h3 className="font-semibold text-base flex items-center border-b border-neutral-200 dark:border-neutral-850 pb-2.5">
          <FolderOpen size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Documents
        </h3>
        {isLoading ? (
          <div className="flex justify-center py-10 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>
        ) : error ? (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
        ) : docs.length === 0 ? (
          <p className="text-xs text-neutral-500 py-8 text-center">No documents visible to you yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pager.slice.map((d) => (
              <div key={d.id} className="p-3.5 bg-neutral-100/50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText size={16} className="text-[#0ea971] shrink-0" />
                  <div className="min-w-0">
                    <span className="text-xs font-bold text-neutral-800 dark:text-slate-200 block truncate">{d.title}</span>
                    <span className="text-2xs text-neutral-500 block">{d.category || 'Uncategorized'}{d.employee?.full_name ? ` · ${d.employee.full_name}` : ' · Company-wide'}</span>
                  </div>
                </div>
                {d.signed && <span className="text-2xs px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-450 rounded-md font-mono shrink-0">SIGNED</span>}
              </div>
            ))}
          </div>
        )}
        <div className="p-3.5 bg-neutral-100 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-start gap-2 text-xs text-neutral-500 dark:text-neutral-450">
          <ShieldAlert size={14} className="text-neutral-600 dark:text-neutral-400 shrink-0 mt-0.5" />
          <p>Access is scoped by role. File upload/storage integration lands in the hardening phase; this registers document records.</p>
        </div>
      </div>


      <Pagination {...pager} noun="documents" />
    </div>
  );
}

