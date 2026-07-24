import React, { useState } from 'react';
import { FolderOpen, Plus, X, ShieldAlert, Loader2, AlertTriangle, FileText } from 'lucide-react';
import { useDocuments, useAddDocument } from '../data/documents';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';

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

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Document Management</h2>
          <p className="text-xs text-neutral-500 dark:text-slate-400">Policies and documents within your scope.</p>
        </div>
        {canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 px-4 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 cursor-pointer shadow-md">
            <Plus size={14} /> Add document
          </button>
        )}
      </div>

      <div className="glass-panel p-5 rounded-2xl space-y-4">
        <h3 className="font-semibold text-base flex items-center border-b border-neutral-200 dark:border-neutral-850 pb-2.5">
          <FolderOpen size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Documents
        </h3>
        {isLoading ? (
          <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
        ) : error ? (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
        ) : docs.length === 0 ? (
          <p className="text-xs text-neutral-500 py-8 text-center">No documents visible to you yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {docs.map((d) => (
              <div key={d.id} className="p-3.5 bg-neutral-100/50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText size={16} className="text-gold-500 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-xs font-bold text-neutral-800 dark:text-slate-200 block truncate">{d.title}</span>
                    <span className="text-[10px] text-neutral-500 block">{d.category || 'Uncategorized'}{d.employee?.full_name ? ` · ${d.employee.full_name}` : ' · Company-wide'}</span>
                  </div>
                </div>
                {d.signed && <span className="text-[9px] px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-450 rounded-md font-mono shrink-0">SIGNED</span>}
              </div>
            ))}
          </div>
        )}
        <div className="p-3.5 bg-neutral-100 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-start gap-2 text-[11px] text-neutral-500 dark:text-neutral-450">
          <ShieldAlert size={14} className="text-neutral-600 dark:text-neutral-400 shrink-0 mt-0.5" />
          <p>Access is scoped by role. File upload/storage integration lands in the hardening phase; this registers document records.</p>
        </div>
      </div>

      {showForm && canManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fade-in" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-md bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="text-sm font-bold">Add Document</h3><button onClick={() => setShowForm(false)} className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"><X size={15} /></button></div>
            <form onSubmit={submit} className="space-y-3 text-xs">
              <div className="space-y-1"><label className="text-neutral-500 font-semibold">Title</label><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Employee Handbook v5" className={INPUT} /></div>
              <div className="space-y-1"><label className="text-neutral-500 font-semibold">Category</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={INPUT}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></div>
              {employee?.id && (
                <label className="flex items-center gap-2 text-[11px] text-neutral-600 dark:text-neutral-300"><input type="checkbox" checked={form.attachSelf} onChange={(e) => setForm({ ...form, attachSelf: e.target.checked })} /> Attach to my own record (else company-wide)</label>
              )}
              {add.error && <p className="text-[11px] text-red-500">{add.error.message}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                <button type="submit" disabled={add.isPending} className="px-3.5 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">{add.isPending && <Loader2 size={13} className="animate-spin" />} Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500';
