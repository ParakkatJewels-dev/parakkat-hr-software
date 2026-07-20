import React, { useState } from 'react';
import { BarChart3, Database, Download, FileSpreadsheet, RefreshCw } from 'lucide-react';

export default function ReportsAnalytics() {
  const [selectedFields, setSelectedFields] = useState({
    id: true, name: true, role: true, department: true, salary: false, joinDate: false
  });
  const [reportType, setReportType] = useState('Employee Directory');
  const [exporting, setExporting] = useState(false);

  const toggleField = (field) => {
    setSelectedFields({
      ...selectedFields,
      [field]: !selectedFields[field]
    });
  };

  const handleExport = () => {
    setExporting(true);
    setTimeout(() => {
      setExporting(false);
      alert('Report exported successfully as CSV/Excel Spreadsheet!');
    }, 1500);
  };

  const dummyReports = [
    { name: 'Q2 Monthly Attendance Muster Roll', date: '2026-07-01', size: '2.5 MB' },
    { name: 'Income Tax Declarations Verification Logs', date: '2026-07-10', size: '1.8 MB' },
    { name: 'Asset Assignment and Serials Registry', date: '2026-07-15', size: '920 KB' }
  ];

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      
      <div>
        <h2 className="text-xl font-bold text-slate-100 font-sans">Reports & Analytics</h2>
        <p className="text-xs text-slate-400">Generate custom operational reports, export data sheets, and build custom database queries</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Side: Report fields builder */}
        <div className="lg:col-span-2 glass-panel p-5 rounded-2xl space-y-5">
          <h3 className="font-semibold text-base flex items-center border-b border-neutral-200 dark:border-neutral-850 pb-2.5">
            <Database size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" />
            <span>Custom Report Builder</span>
          </h3>

          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <label className="text-neutral-500 font-medium">Data Target Category</label>
              <select
                value={reportType}
                onChange={(e) => setReportType(e.target.value)}
                className="w-full bg-neutral-100 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 focus:outline-none focus:border-black dark:focus:border-white cursor-pointer"
              >
                <option value="Employee Directory">Employee Directory Registry</option>
                <option value="Payroll Statements">Payroll & Compensation Logs</option>
                <option value="Leave Summaries">Leave Balances & Utilizations</option>
                <option value="Expense Claims">Reimbursement Spending Logs</option>
              </select>
            </div>
            
            <div className="space-y-1">
              <label className="text-neutral-500 font-medium">Export format</label>
              <div className="flex items-center space-x-1.5 p-2 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl">
                <FileSpreadsheet size={16} className="text-neutral-550 shrink-0" />
                <span className="text-[11px] text-neutral-700 dark:text-neutral-300 font-medium">Excel Spreadsheet (.xlsx)</span>
              </div>
            </div>
          </div>

          {/* Select Fields checkboxes */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-400 block uppercase tracking-wider">Select Fields to Include</span>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Object.keys(selectedFields).map(field => (
                <label 
                  key={field} 
                  className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-colors text-xs ${
                    selectedFields[field] 
                      ? 'bg-neutral-100 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-850 text-neutral-900 dark:text-white font-semibold' 
                      : 'bg-neutral-50/20 dark:bg-neutral-950/20 border-neutral-200 dark:border-neutral-900 text-neutral-500 hover:border-neutral-350 dark:hover:border-neutral-800'
                  }`}
                >
                  <span className="capitalize">{field.replace('id', 'Employee ID').replace('role', 'Designation').replace('joinDate', 'Joining Date')}</span>
                  <input
                    type="checkbox"
                    checked={selectedFields[field]}
                    onChange={() => toggleField(field)}
                    className="hidden"
                  />
                  <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    selectedFields[field] ? 'bg-black dark:bg-white border-black dark:border-white text-white dark:text-black' : 'border-neutral-400'
                  }`}>
                    {selectedFields[field] && <span className="text-[9px] font-bold">✓</span>}
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="border-t border-neutral-200 dark:border-neutral-850 pt-4 flex justify-between items-center">
            <span className="text-xs text-neutral-500 font-mono">Generates export sheet of ~520 employee lines</span>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center space-x-1.5 px-5 py-2.5 bg-black hover:bg-neutral-900 dark:bg-white dark:text-black dark:hover:bg-neutral-200 disabled:opacity-50 text-xs font-semibold rounded-xl text-white transition-all shadow-md cursor-pointer"
            >
              {exporting ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  <span>Compiling Export Sheet...</span>
                </>
              ) : (
                <>
                  <Download size={14} />
                  <span>Compile and Export</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Side: Ready made sheets */}
        <div className="glass-panel p-5 rounded-2xl space-y-4">
          <h3 className="font-semibold text-base flex items-center border-b border-neutral-200 dark:border-neutral-850 pb-2.5">
            <BarChart3 size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" />
            <span>Ready-made Reports</span>
          </h3>

          <div className="space-y-3">
            {dummyReports.map((rep, idx) => (
              <div key={idx} className="p-3.5 bg-neutral-100/50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-neutral-700 dark:text-slate-200 block leading-tight">{rep.name}</span>
                  <span className="text-[10px] text-neutral-500 font-mono">Compiled on {rep.date} • {rep.size}</span>
                </div>
                <button className="p-1.5 hover:bg-neutral-150 dark:hover:bg-neutral-900 rounded text-neutral-600 dark:text-neutral-400 cursor-pointer">
                  <Download size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  );
}
