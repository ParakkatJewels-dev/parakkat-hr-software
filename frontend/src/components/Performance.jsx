import React, { useState, useMemo } from 'react';
import { Target, Plus, Users, Loader2, AlertTriangle } from 'lucide-react';
import { useEmployees } from '../data/employees';

// The employee schema doesn't yet carry ratings/9-box, so this shows a scoped team roster plus a
// lightweight personal goal tracker. A full PMS (goals/reviews tables) is a future module.
export default function Performance() {
  const { data: employees = [], isLoading, error } = useEmployees();
  const [goals, setGoals] = useState([
    { id: 'g1', text: 'Roll out branch-scoped HR access', progress: 100 },
    { id: 'g2', text: 'Onboard all branch managers to the system', progress: 40 },
  ]);
  const [text, setText] = useState('');

  const byDesignation = useMemo(() => {
    const m = employees.reduce((acc, e) => {
      const k = e.designation?.title || 'Unassigned';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12);
  }, [employees]);

  const addGoal = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setGoals([...goals, { id: `g-${goals.length + 1}`, text, progress: 0 }]);
    setText('');
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Performance</h2>
        <p className="text-xs text-neutral-500 dark:text-slate-400">Personal goals and a roster overview scoped to your access. Full reviews/9-box arrive in a later module.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-250 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <Target size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> My Goals
            </h3>
            <div className="space-y-4">
              {goals.map((g) => (
                <div key={g.id} className="space-y-2">
                  <div className="flex justify-between text-xs"><span className="text-neutral-700 dark:text-neutral-300 font-medium">{g.text}</span><span className="font-mono text-neutral-900 dark:text-white font-bold">{g.progress}%</span></div>
                  <input type="range" min="0" max="100" value={g.progress} onChange={(e) => setGoals(goals.map((x) => x.id === g.id ? { ...x, progress: parseInt(e.target.value) } : x))} className="w-full accent-gold-500 bg-neutral-200 dark:bg-neutral-950 h-1.5 rounded-lg cursor-pointer" />
                </div>
              ))}
            </div>
            <form onSubmit={addGoal} className="pt-3 border-t border-neutral-100 dark:border-neutral-900 flex gap-2">
              <input required value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a target…" className="flex-1 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-gold-500" />
              <button type="submit" className="p-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white rounded-xl cursor-pointer"><Plus size={12} /></button>
            </form>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 flex items-center">
              <Users size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Roster by Designation ({employees.length} in scope)
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : (
              <div className="space-y-2">
                {byDesignation.map((d) => (
                  <div key={d.name} className="flex items-center gap-3">
                    <span className="w-40 text-xs text-neutral-600 dark:text-neutral-300 truncate shrink-0">{d.name}</span>
                    <div className="flex-1 bg-neutral-100 dark:bg-neutral-900 rounded-full h-2 overflow-hidden">
                      <div className="h-full bg-gold-450" style={{ width: `${Math.min(100, (d.count / (byDesignation[0]?.count || 1)) * 100)}%` }} />
                    </div>
                    <span className="w-8 text-right text-xs font-mono font-bold text-neutral-800 dark:text-white">{d.count}</span>
                  </div>
                ))}
                {byDesignation.length === 0 && <p className="text-xs text-neutral-500 py-6 text-center">No employees in your scope.</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
