export type OutreachDeliveryStatus =
  | 'Drafted'
  | 'Opened in Mail Client'
  | 'Sent (User Confirmed)'
  | 'Sent (Provider Verified)'
  | 'Delivered'
  | 'Responded'
  | 'Pending Follow-Up'
  | 'Meeting Scheduled'
  | 'Meeting Complete'
  | 'Referred'
  | 'Closed (Positive)'
  | 'Closed (No Response)'
  | 'Re-engage';

export type OutreachVerification =
  | 'none'
  | 'user-confirmed'
  | 'provider-verified'
  | 'preview-simulated';

export function isVerifiedSend(status?: string | null): boolean {
  return [
    'Sent (User Confirmed)',
    'Sent (Provider Verified)',
    'Delivered',
    'Responded',
    // Legacy records created before delivery provenance was introduced.
    'Sent',
    'Awaiting Response',
  ].includes(status || '');
}

export function isProviderVerified(status?: string | null): boolean {
  return ['Sent (Provider Verified)', 'Delivered', 'Responded'].includes(
    status || '',
  );
}

export function deliveryLabel(
  status?: string | null,
  verification?: OutreachVerification | null,
): string {
  if (verification === 'preview-simulated') return 'Preview simulation';
  if (status === 'Opened in Mail Client') return 'Awaiting send confirmation';
  if (verification === 'provider-verified') return 'Verified by provider';
  if (verification === 'user-confirmed') return 'Confirmed by you';
  return status || 'Drafted';
}
