import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
};

type ToastContextType = {
  toast: (message: string, type?: ToastType, durationMs?: number) => void;
};

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

const ICONS: Record<ToastType, React.ComponentType<{ size?: number; className?: string }>> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

const ACCENTS: Record<ToastType, string> = {
  success: 'border-l-[#4C6A69]',
  error: 'border-l-red-600',
  info: 'border-l-ink',
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'info', durationMs = type === 'error' ? 6000 : 3500) => {
    const id = idRef.current++;
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(() => dismiss(id), durationMs);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              className={`animate-toast-in pointer-events-auto flex items-start gap-3 max-w-sm rounded-card border border-ink/15 border-l-4 ${ACCENTS[t.type]} bg-white px-4 py-3 shadow-float`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" />
              <p className="font-mono text-xs leading-relaxed">{t.message}</p>
              <button
                onClick={() => dismiss(t.id)}
                className="ml-auto shrink-0 text-subtle hover:text-ink transition-colors"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
