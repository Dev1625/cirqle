import { useCallback, useEffect, useRef, useState } from 'react';

import { assessPassword } from '../lib/authSecurity';
import {
  checkPasswordBreach,
  type PasswordBreachResult,
  type PasswordBreachViewState,
} from '../lib/passwordBreach';

export function usePasswordBreachCheck(
  password: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [state, setState] = useState<PasswordBreachViewState>({
    status: 'idle',
  });
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentPassword = useRef(password);
  currentPassword.current = password;

  useEffect(() => {
    sequence.current += 1;
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle' });
    return () => controller.current?.abort();
  }, [enabled, password]);

  const checkNow = useCallback(async (): Promise<PasswordBreachResult> => {
    if (!enabled) {
      const result = {
        status: 'unavailable',
        reason: 'disabled',
      } as const;
      setState(result);
      return result;
    }
    if (!assessPassword(password).isStrong) {
      const result = {
        status: 'unavailable',
        reason: 'cancelled',
      } as const;
      setState({ status: 'idle' });
      return result;
    }

    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const requestSequence = ++sequence.current;
    const candidate = password;
    setState({ status: 'checking' });
    const result = await checkPasswordBreach(candidate, {
      signal: requestController.signal,
    });
    if (
      requestSequence === sequence.current &&
      candidate === currentPassword.current
    ) {
      setState(result);
    }
    return result;
  }, [enabled, password]);

  return Object.freeze({
    state,
    checkNow,
  });
}
