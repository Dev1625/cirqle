import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';

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
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending((current) => {
        current?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  const close = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Dialog
        open={Boolean(pending)}
        onClose={() => close(false)}
        title={pending?.title || 'Confirm action'}
        description={pending?.message}
        initialFocusRef={cancelRef}
        className="max-w-md bg-white"
      >
        {pending && (
          <>
            <div className="p-6">
              <h2 className="font-serif text-2xl italic font-bold mb-3">{pending.title}</h2>
              <p className="font-mono text-sm leading-relaxed text-subtle">{pending.message}</p>
            </div>
            <div className="flex justify-end gap-3 p-6 pt-0">
              <Button ref={cancelRef} variant="outline" onClick={() => close(false)}>
                {pending.cancelLabel || 'Cancel'}
              </Button>
              <Button
                variant={pending.tone === 'danger' ? 'danger' : 'default'}
                onClick={() => close(true)}
              >
                {pending.confirmLabel || 'Confirm'}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
};

export const useConfirm = () => useContext(ConfirmContext).confirm;
