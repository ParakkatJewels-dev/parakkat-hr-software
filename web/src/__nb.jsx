import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Menu, Search, Sun } from 'lucide-react';
import './index.css';
function Shell(){
  useEffect(()=>{document.body.classList.add('app-body-lock');return()=>document.body.classList.remove('app-body-lock');},[]);
  return (<div className="app-shell flex h-dvh w-full overflow-hidden bg-neutral-50 relative">
    <div className="app-content flex-1 flex flex-col min-w-0">
      <header className="app-header border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-charcoal-900/85 backdrop-blur-md flex justify-between items-center px-4 sm:px-6 sticky top-0 z-35">
        <div className="flex items-center gap-2 min-w-0"><Menu size={18} /><span>Home</span></div>
        <div className="app-header-actions flex items-center space-x-1.5 sm:space-x-4">
          <button className="p-2"><Search size={18} /></button>
          <button className="p-2"><Sun size={18} /></button>
          <div className="relative">
            <button className="p-2 relative"><Bell size={18} /></button>
            <div className="notification-panel absolute right-0 top-full mt-2 w-[min(19rem,calc(100vw-1rem))] sm:w-80 max-h-[70vh] flex flex-col bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-2xl shadow-2xl z-50 overflow-hidden">
              <div className="px-3.5 py-2.5 border-b"><span className="text-xs font-bold">Notifications</span></div>
              <div className="overflow-y-auto">
                {Array.from({length:8},(_,i)=>(<div key={i} className="px-3.5 py-2.5 border-b text-base">Notification row {i+1}</div>))}
              </div>
            </div>
          </div>
        </div>
      </header>
      <main className="app-main flex-1 min-h-0 overflow-y-auto py-4"><div className="page-shell">content</div></main>
      <nav className="mobile-bottom-nav lg:hidden"><button className="mobile-bottom-nav-item"><Bell size={18}/></button></nav>
    </div>
  </div>);
}
createRoot(document.getElementById('root')).render(<Shell />);
