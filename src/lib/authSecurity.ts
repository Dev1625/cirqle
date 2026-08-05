export type AuthOperation =
  | 'signIn'
  | 'signUp'
  | 'google'
  | 'resetRequest'
  | 'resetConfirm'
  | 'verify'
  | 'reauthenticate';

export interface PasswordAssessment {
  length: boolean;
  lower: boolean;
  upper: boolean;
  numberOrSymbol: boolean;
  notCommon: boolean;
  isStrong: boolean;
  score: number;
}

export interface AccountDeletionReceipt {
  id: string;
  status: 'completed' | 'pending';
  accountLockStatus: 'deleted' | 'deleting' | 'not-managed';
  recordedAt: string;
}

const ACCOUNT_DELETION_RECEIPT_KEY = 'cirqle.account-deletion-receipt.v1';
const RECEIPT_ID = /^[A-Za-z0-9_-]{16,128}$/;

type ReceiptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberAccountDeletionReceipt(
  value: unknown,
  storage: ReceiptStorage = window.sessionStorage,
  now = new Date(),
): AccountDeletionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.id !== 'string' ||
    !RECEIPT_ID.test(receipt.id) ||
    !['completed', 'pending'].includes(String(receipt.status)) ||
    !['deleted', 'deleting', 'not-managed'].includes(
      String(receipt.accountLockStatus),
    )
  ) {
    return null;
  }
  const normalized: AccountDeletionReceipt = {
    id: receipt.id,
    status: receipt.status as AccountDeletionReceipt['status'],
    accountLockStatus:
      receipt.accountLockStatus as AccountDeletionReceipt['accountLockStatus'],
    recordedAt: now.toISOString(),
  };
  storage.setItem(ACCOUNT_DELETION_RECEIPT_KEY, JSON.stringify(normalized));
  return normalized;
}

export function readAccountDeletionReceipt(
  storage: ReceiptStorage = window.sessionStorage,
): AccountDeletionReceipt | null {
  try {
    const raw = storage.getItem(ACCOUNT_DELETION_RECEIPT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      !RECEIPT_ID.test(value.id) ||
      !['completed', 'pending'].includes(String(value.status)) ||
      !['deleted', 'deleting', 'not-managed'].includes(
        String(value.accountLockStatus),
      ) ||
      typeof value.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.recordedAt))
    ) {
      storage.removeItem(ACCOUNT_DELETION_RECEIPT_KEY);
      return null;
    }
    return value as unknown as AccountDeletionReceipt;
  } catch {
    storage.removeItem(ACCOUNT_DELETION_RECEIPT_KEY);
    return null;
  }
}

export function clearAccountDeletionReceipt(
  storage: ReceiptStorage = window.sessionStorage,
): void {
  storage.removeItem(ACCOUNT_DELETION_RECEIPT_KEY);
}

export function assessPassword(password: string): PasswordAssessment {
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  const commonFragments = [
    'password',
    'qwerty',
    'letmein',
    'welcome',
    'admin123',
    'iloveyou',
    'changeme',
    'abc123',
    'monkey',
    'dragon',
  ];
  const checks = {
    length: password.length >= 10 && password.length <= 128,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    numberOrSymbol: /[^A-Za-z\s]/.test(password),
    notCommon:
      !/^(?:123456(?:789)?|111111|000000|654321)$/.test(normalized) &&
      !commonFragments.some((fragment) => normalized.includes(fragment)),
  };
  const score = Object.values(checks).filter(Boolean).length;
  return { ...checks, score, isStrong: score === 5 };
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return '';
}

/** Keep Firebase's internal error details out of user-facing messages. */
export function friendlyAuthError(
  error: unknown,
  operation: AuthOperation,
): string {
  const code = errorCode(error);

  if (
    operation === 'resetRequest' &&
    ['auth/user-not-found', 'auth/invalid-credential'].includes(code)
  ) {
    return 'If an account exists for that address, a reset link is on its way.';
  }

  switch (code) {
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/email-already-in-use':
      return 'That email already has an account. Log in or reset the password instead.';
    case 'auth/weak-password':
      return 'Choose a longer password using uppercase, lowercase, and a number or symbol.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password combination did not match. Try again or reset your password.';
    case 'auth/user-disabled':
      return 'This account is currently disabled. Contact support if that seems wrong.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth/network-request-failed':
      return 'We could not reach the sign-in service. Check your connection and try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in window. Allow popups and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled. You can try again when you are ready.';
    case 'auth/account-exists-with-different-credential':
      return 'That email already uses another sign-in method. Log in the same way you originally joined.';
    case 'auth/operation-not-allowed':
      return 'That sign-in method is temporarily unavailable. Continue with Google or try again later.';
    case 'auth/requires-recent-login':
      return 'For your security, verify your identity again before continuing.';
    case 'auth/expired-action-code':
      return 'That link has expired. Request a fresh email and try again.';
    case 'auth/invalid-action-code':
      return 'That link is invalid or has already been used. Request a fresh email.';
    case 'auth/user-token-expired':
      return 'Your session expired. Log in again to continue.';
    default:
      if (operation === 'resetRequest') {
        return 'We could not send a reset email right now. Please try again.';
      }
      if (operation === 'verify') {
        return 'We could not verify that email link. Request a fresh one and try again.';
      }
      if (operation === 'reauthenticate') {
        return 'We could not verify your identity. Check your details and try again.';
      }
      if (operation === 'google') {
        return 'Google sign-in could not be completed. Please try again.';
      }
      return 'Something went wrong while signing you in. Please try again.';
  }
}
