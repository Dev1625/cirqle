import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

// europe/us choice is not meaningful yet; pinned so it does not silently
// change when the default does.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

/**
 * Files an NFC card tap into the owner's Directory the moment it happens.
 *
 * Previously this only ran client-side, on the owner's *next app load*, which
 * is fine for correctness and bad for the demo that sells the feature: you tap
 * a card, the other person opens their phone, and nothing is there. Now the
 * contact exists before they finish putting the phone away.
 *
 * ── On not filing the same capture twice ──────────────────────────────────
 *
 * The client-side drain (src/hooks/useCaptureDrain.ts) still exists, because
 * the whole flow has to keep working with nothing deployed. So for a while
 * both paths are live and could race on the same capture.
 *
 * Both now *claim* the capture in a transaction before writing anything: read
 * the capture doc, bail if it is already gone, then create the contact and
 * delete the capture in the same atomic commit. Whichever path gets there
 * first wins and the other finds nothing. That is why the contact write uses
 * a pre-generated ref and transaction.create rather than the more obvious
 * collection.add — add() cannot participate in a transaction.
 */
export const onCardCapture = onDocumentCreated(
  'cards/{cardId}/captures/{captureId}',
  async (event) => {
    const { cardId, captureId } = event.params;
    const captureRef = db.doc(`cards/${cardId}/captures/${captureId}`);

    const cardSnap = await db.doc(`cards/${cardId}`).get();
    if (!cardSnap.exists) {
      console.warn(`[onCardCapture] card ${cardId} missing; leaving capture ${captureId} for the client drain`);
      return;
    }

    const ownerUid = cardSnap.data()?.ownerUid;
    if (!ownerUid) {
      console.error(`[onCardCapture] card ${cardId} has no ownerUid; cannot file capture ${captureId}`);
      return;
    }

    // Event Mode lives on the owner's user document. Read it outside the
    // transaction: it is advisory context for the summary line, and making
    // the transaction depend on it would widen the contention window for no
    // benefit.
    let eventName = null;
    try {
      const ownerSnap = await db.doc(`users/${ownerUid}`).get();
      const eventMode = ownerSnap.data()?.eventMode;
      if (eventMode?.active && eventMode.eventName) eventName = eventMode.eventName;
    } catch (error) {
      console.warn(`[onCardCapture] could not read event mode for ${ownerUid}`, error);
    }

    try {
      await db.runTransaction(async (tx) => {
        const capture = await tx.get(captureRef);
        if (!capture.exists) {
          // The client drain got here first. Nothing to do, and importantly
          // not an error.
          return;
        }

        const data = capture.data() || {};
        const when = data.capturedAt?.toDate?.() || new Date();

        const contextBits = [
          `Tapped your card ${when.toLocaleDateString('en-US')} at ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
          eventName ? `at ${eventName}` : null,
        ].filter(Boolean);

        const contactRef = db.collection(`users/${ownerUid}/contacts`).doc();
        tx.create(contactRef, {
          userId: ownerUid,
          name: data.visitorName || 'Unknown',
          company: data.visitorCompany || null,
          role: null,
          industry: null,
          relationshipTier: 'Cold',
          summary: contextBits.join(' '),
          whyTheyMatter: data.note || null,
          tags: eventName ? [eventName] : [],
          location: null,
          email: data.visitorEmail || null,
          linkedinUrl: null,
          subIndustry: null,
          lastContactedAt: when,
          seniority: null,
          school: null,
          connectionSource: 'NFC card',
          capturedVia: 'nfc-card',
          capturedAt: when,
          capturedEventName: eventName,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.delete(captureRef);
      });
    } catch (error) {
      // Leaving the capture in place is the correct failure mode: the client
      // drain will pick it up on the owner's next load, so a transient error
      // here delays the contact rather than losing it.
      console.error(`[onCardCapture] failed to file capture ${captureId} for ${ownerUid}`, error);
      throw error;
    }
  }
);
