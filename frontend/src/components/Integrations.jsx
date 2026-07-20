import React, { useState } from 'react';
import { initialIntegrations } from '../mockData';
import { Share2, ToggleLeft, ToggleRight, Sparkles } from 'lucide-react';

export default function Integrations() {
  const [integrations, setIntegrations] = useState(initialIntegrations);

  const toggleConnection = (id) => {
    setIntegrations(integrations.map(int => 
      int.id === id ? { ...int, connected: !int.connected } : int
    ));
  };

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      
      <div>
        <h2 className="text-xl font-bold text-slate-100 font-sans">Integrations & REST APIs</h2>
        <p className="text-xs text-slate-400">Sync with third-party messaging workspaces, calendar managers, biometric gates, and banking ledgers</p>
      </div>

      <div className="glass-panel p-5 rounded-2xl space-y-4">
        <h3 className="font-semibold text-base flex items-center border-b border-neutral-200 dark:border-neutral-850 pb-2.5">
          <Share2 size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" />
          <span>Connected Applications Registry</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {integrations.map(app => (
            <div 
              key={app.id} 
              className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 transition-colors ${
                app.connected 
                  ? 'bg-neutral-100/50 dark:bg-neutral-900/30 border-neutral-300 dark:border-neutral-850' 
                  : 'bg-neutral-50/20 dark:bg-neutral-950/20 border-neutral-200 dark:border-neutral-900 opacity-70'
              }`}
            >
              <div>
                <div className="flex justify-between items-start">
                  <span className="font-bold text-xs text-neutral-800 dark:text-slate-200 block">{app.name}</span>
                  <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 bg-neutral-200 dark:bg-neutral-900 text-neutral-500 rounded">
                    {app.type}
                  </span>
                </div>
                <p className="text-[10.5px] text-neutral-500 dark:text-neutral-450 mt-1.5 leading-snug">{app.desc}</p>
              </div>

              <div className="flex justify-between items-center border-t border-neutral-150 dark:border-neutral-900/40 pt-2.5 mt-2">
                <span className={`text-[10px] font-mono font-semibold ${
                  app.connected ? 'text-emerald-600 dark:text-emerald-450' : 'text-neutral-450'
                }`}>
                  {app.connected ? 'Connected' : 'Disconnected'}
                </span>
                
                <button
                  onClick={() => toggleConnection(app.id)}
                  className="cursor-pointer transition-transform active:scale-95 text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white"
                >
                  {app.connected ? (
                    <ToggleRight size={26} className="text-black dark:text-white" />
                  ) : (
                    <ToggleLeft size={26} className="text-neutral-350 dark:text-neutral-700" />
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
