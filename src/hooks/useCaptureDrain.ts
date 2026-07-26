import { useEffect, useRef } from 'react';
import { drainCaptures } from '../lib/card';
import { readEventMode } from '../lib/eventMode';
import { useToast } from '../contexts/ToastContext';

/**
 * Turns pending card taps into real contacts when the owner next opens the app.
 *
 * This runs client-side so the whole NFC flow is demoable with nothing
 * deployed. In production the same write belongs in a Firestore onCreate
 * trigger, so the contact appears the instant someone taps rather than on the
 * owner's next visit — see FEATURE_BUILD_REPORT.md.
 *
 * Guarded by a ref rather than an empty dep array because React 18 StrictMode
 * mounts effects twice in development, and draining twice would file every
 * captured contact two times.
 */
export function useCaptureDrain(uid: string | undefined, profile: any | null) {
  const { toast } = useToast();
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    const cardId = profile?.cardId;
    if (!uid || !cardId) return;

    const key = `${uid}:${cardId}`;
    if (ranFor.current === key) return;
    ranFor.current = key;

    const eventMode = readEventMode(profile);

    drainCaptures({
      uid,
      cardId,
      eventName: eventMode.active ? eventMode.eventName : null,
    })
      .then((created) => {
        if (created > 0) {
          toast(
            created === 1
              ? 'Someone tapped your card — they are in your Directory.'
              : `${created} card taps filed into your Directory.`,
            'success'
          );
        }
      })
      .catch(() => {
        // A failed drain is not worth interrupting the user for: the captures
        // stay pending and the next app load tries again.
      });
  }, [uid, profile?.cardId, profile?.eventMode, toast]);
}
