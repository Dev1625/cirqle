import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
};

type ToastContextType = {
  toast: (
    message: string,
    type?: ToastType,
    durationMs?: number,
    action?: ToastItem['action'],
  ) => void;
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
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'info', durationMs = type === 'error' ? 0 : 5000, action?: ToastItem['action']) => {
    const id = idRef.current++;
    setToasts((current) => [...current, { id, message, type, action }]);
    // Errors persist until dismissed so recovery instructions never vanish
    // while someone is reading or navigating with assistive technology.
    if (durationMs > 0) {
      timersRef.current.set(
        id,
        window.setTimeout(() => dismiss(id), durationMs),
      );
    }
  }, [dismiss]);

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed left-4 right-4 top-4 z-[100] flex flex-col gap-3 sm:left-auto sm:right-6 sm:top-6"
        aria-label="Notifications"
        aria-relevant="additions"
      >
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              aria-live={t.type === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 self-end rounded-card border border-ink/15 border-l-4 bg-white px-4 py-3 shadow-float animate-toast-in ${ACCENTS[t.type]}`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed">{t.message}</p>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    void t.action?.onClick();
                  }}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center px-2 font-mono text-[10px] font-bold uppercase tracking-widest text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-m-2 ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-subtle transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label={`Dismiss notification: ${t.message}`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
