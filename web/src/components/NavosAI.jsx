import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, Send, Sparkles, X, ChevronUp, Bot } from 'lucide-react';

export default function NavosAI({ onNavigate }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { id: '1', sender: 'bella', text: 'Hi! I am Bella, your NAVOS AI HR assistant. How can I help you today? You can type requests like "apply leave" or "submit expense".' }
  ]);
  const [inputText, setInputText] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (textToSend) => {
    const query = textToSend || inputText;
    if (!query.trim()) return;

    // User Message
    const userMsg = { id: `u-${Date.now()}`, sender: 'user', text: query };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');

    // Navigation-only assistant: routes you to the right module (actions happen there, scoped by RLS).
    setTimeout(() => {
      const q = query.toLowerCase();
      let botResponse = '';
      if (q.includes('leave') || q.includes('time off')) {
        onNavigate?.('leave');
        botResponse = 'Opening Leave Management — apply for or review leave there.';
      } else if (q.includes('expense') || q.includes('claim') || q.includes('reimburse')) {
        onNavigate?.('expense');
        botResponse = 'Opening Expense Management to submit or review claims.';
      } else if (q.includes('payslip') || q.includes('salary') || q.includes('pay')) {
        onNavigate?.('payroll');
        botResponse = 'Opening Payroll — your payslips are there.';
      } else if (q.includes('job') || q.includes('recruit') || q.includes('hiring')) {
        onNavigate?.('recruitment');
        botResponse = 'Opening Recruitment — job openings and candidate pipeline.';
      } else if (q.includes('ticket') || q.includes('issue') || q.includes('helpdesk')) {
        onNavigate?.('helpdesk');
        botResponse = 'Opening Helpdesk — raise or track a ticket there.';
      } else if (q.includes('directory') || q.includes('employee') || q.includes('staff')) {
        onNavigate?.('directory');
        botResponse = 'Opening the Employee Directory.';
      } else {
        botResponse = "Try: 'leave', 'expense', 'payslip', 'jobs', 'ticket', or 'directory' and I'll take you there.";
      }
      setMessages((prev) => [...prev, { id: `b-${prev.length}`, sender: 'bella', text: botResponse }]);
    }, 700);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') handleSend();
  };

  const quickPrompts = [
    { text: 'Apply leave for tomorrow', query: 'apply leave tomorrow' },
    { text: 'Submit conveyance expense ₹800', query: 'submit expense 800' },
    { text: 'Open latest payslip', query: 'show payslip' },
    { text: 'Show active jobs list', query: 'show jobs' }
  ];

  return (
    <>
      {/* Floating Toggle button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 p-4 bg-black dark:bg-white text-white dark:text-black rounded-full shadow-2xl hover:scale-105 active:scale-95 transition-all duration-300 z-40 cursor-pointer flex items-center space-x-2 border border-neutral-300 dark:border-neutral-800"
        >
          <Bot size={22} className="animate-pulse" />
          {/* <span className="text-xs font-semibold tracking-wide pr-1 ">AI</span> */}
        </button>
      )}

      {/* Floating Chat Widget */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 max-w-full bg-white dark:bg-neutral-950 border border-neutral-250 dark:border-neutral-900 shadow-2xl flex flex-col h-[480px] z-50 overflow-hidden animate-fade-in transition-colors duration-200">
          {/* Header */}
          <div className="p-4 bg-black dark:bg-neutral-900 border-b border-neutral-250 dark:border-neutral-900 flex justify-between items-center text-white">
            <div className="flex items-center space-x-2">
              <Bot size={20} className="text-neutral-350 dark:text-neutral-400" />
              <div>
                <h3 className="font-bold text-xs text-white">NAVOS AI assistant</h3>
                <span className="text-[9px] text-neutral-400 flex items-center">
                  <Sparkles size={8} className="mr-0.5 text-white animate-pulse" /> Powered by Bella Bot
                </span>
              </div>
            </div>
            <button 
              onClick={() => setIsOpen(false)}
              className="p-1 bg-neutral-900 dark:bg-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-white rounded-lg cursor-pointer transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          {/* Messages scroll area */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-neutral-50 dark:bg-neutral-950/20">
            {messages.map(msg => (
              <div 
                key={msg.id} 
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[80%] p-3 rounded-xl text-xs leading-normal ${
                  msg.sender === 'user' 
                    ? 'bg-black text-white dark:bg-white dark:text-black rounded-tr-none shadow-sm' 
                    : 'bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 rounded-tl-none font-medium'
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Quick prompt suggestions */}
          <div className="p-2 border-t border-neutral-200 dark:border-neutral-850 bg-neutral-100 dark:bg-neutral-950/40 flex flex-wrap gap-1.5 max-h-[85px] overflow-y-auto">
            {quickPrompts.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(prompt.query)}
                className="text-[9px] px-2 py-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-lg text-neutral-700 dark:text-neutral-350 hover:bg-black hover:text-white dark:hover:bg-white dark:hover:text-black transition-all cursor-pointer truncate max-w-[170px]"
                title={prompt.text}
              >
                {prompt.text}
              </button>
            ))}
          </div>

          {/* Input box */}
          <div className="p-3 border-t border-neutral-200 dark:border-neutral-855 bg-white dark:bg-neutral-900 flex space-x-2 items-center">
            <input
              type="text"
              placeholder="Ask NAVOS or type commands..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyPress}
              className="flex-1 bg-neutral-100 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 text-xs text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-black dark:focus:border-white"
            />
            <button
              onClick={() => handleSend()}
              className="p-2.5 bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-900 dark:hover:bg-neutral-150 rounded-xl cursor-pointer transition-colors shrink-0 shadow-md"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
