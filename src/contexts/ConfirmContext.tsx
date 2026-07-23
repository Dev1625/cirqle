import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

type ConfirmContextType = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextType>({ confirm: async () => false });

export const ConfirmProvider = ({ children }: { children: React.ReactNode }) => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const close = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm animate-fade-in"
          onClick={(e) => { if (e.target === e.currentTarget) close(false); }}
        >
          <div className="animate-fade-scale-in bg-white border border-ink w-full max-w-md shadow-[12px_12px_0px_0px_rgba(26,26,26,1)]">
            <div className="p-6">
              <h2 className="font-serif text-2xl italic font-bold mb-3">{pending.title}</h2>
              <p className="font-mono text-sm leading-relaxed text-subtle">{pending.message}</p>
            </div>
            <div className="flex justify-end gap-3 p-6 pt-0">
              <Button variant="outline" onClick={() => close(false)}>
                {pending.cancelLabel || 'Cancel'}
              </Button>
              <Button
                variant={pending.tone === 'danger' ? 'danger' : 'default'}
                onClick={() => close(true)}
              >
                {pending.confirmLabel || 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

export const useConfirm = () => useContext(ConfirmContext).confirm;
