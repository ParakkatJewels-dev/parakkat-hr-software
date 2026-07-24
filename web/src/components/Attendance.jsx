import React, { useMemo } from 'react';
import { Clock, Calendar, AlertTriangle, Loader2 } from 'lucide-react';
import { useAttendance, usePunch } from '../data/attendance';
import { useAuth } from '../auth/AuthContext';

const todayStr = () => new Date().toISOString().split('T')[0];
const nowIso = () => new Date().toISOString();
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--');

const statusClass = (s) =>
  s === 'On Time'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450'
    : s === 'Late In'
    ? 'bg-amber-105 text-amber-805 dark:bg-amber-950/45 dark:text-amber-450'
    : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-455';

export default function Attendance() {
  const { data: logs = [], isLoading, error } = useAttendance();
  const { employee } = useAuth();
  const punch = usePunch();
  const canPunch = Boolean(employee?.id);

  // today's own row -> checked-in if it has a check_in and no check_out
  const todayRow = useMemo(
    () => logs.find((l) => l.work_date === todayStr() && l.employee?.employee_code === employee?.employee_code),
    [logs, employee]
  );
  const checkedIn = Boolean(todayRow?.check_in && !todayRow?.check_out);

  const checkIn = () => {
    const now = new Date();
    const late = now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() > 15);
    punch.mutate({ employee_id: employee.id, work_date: todayStr(), check_in: nowIso(), check_out: null, status: late ? 'Late In' : 'On Time' });
  };
  const checkOut = () => {
    const ci = todayRow?.check_in ? new Date(todayRow.check_in) : new Date();
    const hours = Math.max(0, Math.round(((Date.now() - ci.getTime()) / 3600000) * 10) / 10);
    punch.mutate({ employee_id: employee.id, work_date: todayStr(), check_in: todayRow?.check_in || nowIso(), check_out: nowIso(), hours, status: todayRow?.status || 'On Time' });
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Attendance</h2>
        <p className="text-xs text-neutral-500 dark:text-slate-400">Punch in/out and review attendance across your scope.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* punch portal */}
        <div className="lg:col-span-1 space-y-6">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-250 flex items-center">
              <Clock size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Punching Portal
            </h3>
            <div className="text-center py-6 bg-neutral-50 dark:bg-neutral-950/40 rounded-xl border border-neutral-200 dark:border-neutral-850">
              <span className="text-[9px] text-neutral-500 font-mono tracking-widest block uppercase font-bold">session state</span>
              <span className={`text-base font-extrabold font-mono mt-1.5 block ${checkedIn ? 'text-emerald-600 dark:text-emerald-450' : 'text-neutral-400'}`}>
                {checkedIn ? 'ACTIVE CLOCK-IN' : 'SIGNED OUT'}
              </span>
              <span className="text-2xl font-black font-mono block mt-2 text-neutral-800 dark:text-neutral-100">
                {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {canPunch ? (
              checkedIn ? (
                <button onClick={checkOut} disabled={punch.isPending} className="w-full py-2.5 bg-neutral-900 hover:bg-neutral-800 dark:bg-neutral-100 dark:text-black dark:hover:bg-white text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-60">
                  Sign-Out / End Day
                </button>
              ) : (
                <button onClick={checkIn} disabled={punch.isPending} className="w-full py-2.5 bg-black hover:bg-neutral-900 dark:bg-gold-450 dark:text-charcoal-900 text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-60">
                  Sign-In / Start Day
                </button>
              )
            ) : (
              <p className="text-[10.5px] text-neutral-400 text-center">
                Your login isn't linked to an employee, so you can't punch. You can still review the logs below.
              </p>
            )}
          </div>

          <div className="premium-card p-4 flex items-start space-x-3.5 border-l-4 border-l-black dark:border-l-gold-450">
            <div className="p-2 bg-neutral-100 dark:bg-neutral-900 text-neutral-805 dark:text-neutral-200 rounded-lg shrink-0"><AlertTriangle size={16} /></div>
            <div>
              <h4 className="font-bold text-xs text-neutral-800 dark:text-slate-200">General Day Shift (GDS)</h4>
              <p className="text-[10.5px] text-neutral-500 dark:text-neutral-450 mt-1 leading-relaxed">09:00 AM – 06:00 PM · 15 min grace. Late-ins beyond 15 min are flagged.</p>
            </div>
          </div>
        </div>

        {/* logs */}
        <div className="lg:col-span-2">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 flex items-center">
              <Calendar size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Punch Registry
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : logs.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">No attendance records visible to you yet.</p>
            ) : (
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th>Date</th><th>Employee</th><th>In</th><th>Out</th><th>Hrs</th><th className="text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="font-sans font-semibold text-neutral-805 dark:text-slate-300">{log.work_date}</td>
                        <td className="font-sans text-neutral-600 dark:text-neutral-400">{log.employee?.full_name || '—'}{log.employee?.branch?.code ? ` (${log.employee.branch.code})` : ''}</td>
                        <td className="text-neutral-600 dark:text-neutral-400">{fmtTime(log.check_in)}</td>
                        <td className="text-neutral-600 dark:text-neutral-400">{fmtTime(log.check_out)}</td>
                        <td className="text-neutral-600 dark:text-neutral-400">{log.hours ?? '—'}</td>
                        <td className="text-right font-sans">
                          <span className={`px-2 py-0.5 rounded-full text-[8.5px] font-bold uppercase tracking-wider ${statusClass(log.status)}`}>{log.status || '—'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
