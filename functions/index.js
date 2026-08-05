import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import {
  MAX_CAPTURE_CONTACT_MATCHES,
  buildCaptureEvidence,
  captureContactDocumentId,
  captureEvidenceSummary,
  captureFactDocumentId,
  captureRecordDocumentId,
  chooseExistingCaptureContact,
  normalizeCaptureEmail,
} from './capture-filing.js';

initializeApp();
const db = getFirestore();

// Google OAuth/Gmail/Calendar HTTP traffic is served only by the Vercel
// /api/integrations routes so there is one callback and state authority.

// europe/us choice is not meaningful yet; pinned so it does not silently
// change when the default does.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

function opaqueLogRef(value) {
  return createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function stableErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9._/-]{1,80}$/.test(code) ? code : 'unknown';
}

function captureChannelDetails(value) {
  if (value === 'qr') {
    return {
      channel: 'qr',
      connectionSource: 'QR code',
      capturedVia: 'qr-code',
      summary: 'Scanned your QR code',
    };
  }
  if (value === 'nfc') {
    return {
      channel: 'nfc',
      connectionSource: 'NFC card',
      capturedVia: 'nfc-card',
      summary: 'Tapped your NFC card',
    };
  }
  if (value === 'link') {
    return {
      channel: 'link',
      connectionSource: 'Shared link',
      capturedVia: 'shared-link',
      summary: 'Saved from your shared card link',
    };
  }
  return {
    channel: 'direct',
    connectionSource: 'Public card page',
    capturedVia: 'public-card',
    summary: 'Saved from your public card page',
  };
}

/**
 * Files a public-card capture into the owner's Directory the moment it
 * happens. The distribution channel is an allowlisted URL marker, not proof
 * that a particular piece of hardware was used.
 *
 * Capture filing is server-only. Browser rules deny capture-evidence writes,
 * so the ownership check, deduplication, provenance fields, and deletion of
 * the pending capture all happen in one trusted transaction here.
 *
 * ── On not filing the same capture twice ──────────────────────────────────
 *
 * The function claims the capture in a transaction before writing anything:
 * it reads the capture document, creates or updates the contact and evidence,
 * then deletes the pending capture in the same atomic commit. Retries find the
 * capture already gone and cannot create a duplicate contact.
 */
export const onCardCapture = onDocumentCreated(
  {
    document: 'cards/{cardId}/captures/{captureId}',
    retry: true,
  },
  async (event) => {
    const { cardId, captureId } = event.params;
    const captureRef = db.doc(`cards/${cardId}/captures/${captureId}`);

    const cardSnap = await db.doc(`cards/${cardId}`).get();
    if (!cardSnap.exists) {
      console.warn('[onCardCapture] card_missing', {
        cardRef: opaqueLogRef(cardId),
        captureRef: opaqueLogRef(captureId),
      });
      return;
    }

    const ownerUid = cardSnap.data()?.ownerUid;
    if (!ownerUid) {
      console.error('[onCardCapture] card_owner_missing', {
        cardRef: opaqueLogRef(cardId),
        captureRef: opaqueLogRef(captureId),
      });
      return;
    }

    // Event Mode lives on the owner's user document. Read it outside the
    // transaction: it is advisory context for the summary line, and making
    // the transaction depend on it would widen the contention window for no
    // benefit.
    let eventName = null;
    let eventSessionId = null;
    let eventSource = null;
    try {
      const ownerSnap = await db.doc(`users/${ownerUid}`).get();
      const eventMode = ownerSnap.data()?.eventMode;
      if (eventMode?.active && eventMode.eventName) {
        eventName = eventMode.eventName;
        eventSessionId = eventMode.sessionId || null;
        eventSource = eventMode.source || null;
      }
    } catch (error) {
      console.warn('[onCardCapture] event_mode_read_failed', {
        ownerRef: opaqueLogRef(ownerUid),
        errorCode: stableErrorCode(error),
      });
    }

    try {
      await db.runTransaction(async (tx) => {
        const [capture, security] = await Promise.all([
          tx.get(captureRef),
          tx.get(db.doc(`_accountSecurity/${ownerUid}`)),
        ]);
        if (!capture.exists) {
          // A prior delivery already committed. Nothing to do, and
          // importantly not an error.
          return;
        }
        if (
          !security.exists ||
          security.data()?.status !== 'active'
        ) {
          // Deletion/session locks win over a queued trigger. Discard the
          // visitor submission instead of recreating private CRM data.
          tx.delete(captureRef);
          return;
        }

        const data = capture.data() || {};
        const when = data.capturedAt?.toDate?.() || new Date();
        const capturedEventName = data.eventName || eventName;
        const capturedEventSessionId = data.eventSessionId || eventSessionId;
        const capturedEventSource = data.eventSource || eventSource;
        const captureChannel = captureChannelDetails(data.captureChannel);
        const normalizedEmail = normalizeCaptureEmail(data.visitorEmail);
        const contacts = db.collection(`users/${ownerUid}/contacts`);
        const deterministicContactId =
          captureContactDocumentId(normalizedEmail);
        const deterministicContactRef = deterministicContactId
          ? contacts.doc(deterministicContactId)
          : null;

        let matchingContacts = [];
        let deterministicContact = null;
        if (normalizedEmail && deterministicContactRef) {
          const [canonicalMatches, legacyMatches, deterministic] =
            await Promise.all([
              tx.get(
                contacts
                  .where('normalizedEmail', '==', normalizedEmail)
                  .limit(MAX_CAPTURE_CONTACT_MATCHES),
              ),
              tx.get(
                contacts
                  .where('email', '==', normalizedEmail)
                  .limit(MAX_CAPTURE_CONTACT_MATCHES),
              ),
              tx.get(deterministicContactRef),
            ]);
          matchingContacts = [
            ...canonicalMatches.docs,
            ...legacyMatches.docs,
          ].filter(
            (document, index, documents) =>
              documents.findIndex(
                (candidate) => candidate.id === document.id,
              ) === index,
          );
          deterministicContact = deterministic;
          if (
            deterministic.exists &&
            !matchingContacts.some(
              (document) => document.id === deterministic.id,
            )
          ) {
            matchingContacts.push(deterministic);
          }
        }

        const existingContact = chooseExistingCaptureContact(
          matchingContacts,
          normalizedEmail,
        );
        const contactRef =
          existingContact?.ref ||
          (deterministicContactRef && !deterministicContact?.exists
            ? deterministicContactRef
            : contacts.doc());
        const deduplicated = Boolean(existingContact);

        const contextBits = [
          `${captureChannel.summary} ${when.toLocaleDateString('en-US')} at ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
          capturedEventName ? `at ${capturedEventName}` : null,
        ].filter(Boolean);

        if (!deduplicated) {
          tx.create(contactRef, {
            userId: ownerUid,
            name: data.visitorName || 'Unknown',
            company: data.visitorCompany || '',
            role: '',
            phone: '',
            industry: '',
            relationshipTier: 'Cold',
            lifecycleStatus: 'active',
            aiAllowed: true,
            profileRevision: 0,
            summary: contextBits.join(' '),
            whyTheyMatter: data.note || '',
            tags: capturedEventName ? [capturedEventName] : [],
            location: '',
            email: normalizedEmail || '',
            normalizedEmail: normalizedEmail || '',
            linkedinUrl: '',
            subIndustry: '',
            lastContactedAt: when,
            seniority: '',
            school: '',
            connectionSource: captureChannel.connectionSource,
            capturedVia: captureChannel.capturedVia,
            captureChannel: captureChannel.channel,
            capturedAt: when,
            capturedEventName,
            capturedEventSessionId,
            capturedEventSource,
            consentToFollowUp: data.consentToFollowUp === true,
            consentRecordedAt:
              data.consentToFollowUp === true ? when : null,
            privacyNoticeVersion: data.privacyNoticeVersion || null,
            captureProvenance: {
              sourceType: 'public-card',
              sourceId: captureId,
              cardId,
              eventSessionId: capturedEventSessionId,
              channel: captureChannel.channel,
              channelEvidence:
                captureChannel.channel === 'direct'
                  ? 'unmarked-url'
                  : 'client-url-marker',
              channelVerified: false,
            },
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        const evidence = buildCaptureEvidence({
          cardId,
          captureId,
          contactId: contactRef.id,
          data: {
            ...data,
            visitorEmail: normalizedEmail,
            eventName: capturedEventName,
            eventSessionId: capturedEventSessionId,
            eventSource: capturedEventSource,
            captureChannel: captureChannel.channel,
          },
          capturedAt: when,
          deduplicated,
        });
        const evidenceSummary = captureEvidenceSummary(evidence);
        tx.create(
          db.doc(
            `users/${ownerUid}/notes/${captureRecordDocumentId(
              cardId,
              captureId,
            )}`,
          ),
          {
            noteSchemaVersion: 2,
            userId: ownerUid,
            contactId: contactRef.id,
            recordType: 'capture',
            source: 'public-card-capture',
            privacySourceType: 'public-card-capture',
            sourceId: captureId,
            content: evidenceSummary,
            sensitive: false,
            aiAllowed: true,
            factIds: [],
            observedAt: when,
            capturedAt: when,
            visitorName: evidence.visitorName,
            visitorEmail: evidence.visitorEmail,
            visitorCompany: evidence.visitorCompany,
            consentToFollowUp: evidence.consentToFollowUp,
            consentRecordedAt: evidence.consentRecordedAt,
            privacyNoticeVersion: evidence.privacyNoticeVersion,
            eventSessionId: evidence.eventSessionId,
            eventName: evidence.eventName,
            eventSource: evidence.eventSource,
            captureChannel: evidence.channel,
            captureProvenance: {
              sourceType: evidence.sourceType,
              sourceId: evidence.sourceId,
              cardId: evidence.cardId,
              eventSessionId: evidence.eventSessionId,
              channel: evidence.channel,
              channelEvidence: evidence.channelEvidence,
              channelVerified: false,
            },
            deduplicatedIntoExistingContact:
              evidence.deduplicatedIntoExistingContact,
            immutableEvidence: true,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
        );

        // New contacts receive identity facts. Existing contacts receive only
        // the capture evidence below, so their owner-curated profile remains
        // unchanged even when the submitted name or company differs.
        if (!deduplicated) {
          const facts = [
            ['identity.name', data.visitorName || 'Unknown', 1],
            ['identity.company', data.visitorCompany || null, 0.95],
            ['identity.email', normalizedEmail, 0.95],
            [
              'relationship.connectionSource',
              captureChannel.connectionSource,
              1,
            ],
            ['relationship.event', capturedEventName || null, 1],
          ].filter(([, value]) => value != null && String(value).trim());

          for (const [predicate, value, confidence] of facts) {
            const factRef = contactRef.collection('facts').doc();
            tx.create(factRef, {
              predicate,
              value,
              normalizedValue: String(value).trim().toLowerCase(),
              sourceType: 'public-card-capture',
              sourceId: captureId,
              observedAt: when,
              confidence,
              current: true,
              aiAllowed: true,
              correctionOf: null,
              supersededBy: null,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        }

        tx.create(
          contactRef
            .collection('facts')
            .doc(captureFactDocumentId(cardId, captureId)),
          {
            predicate: 'relationship.captureEvidence',
            value: evidenceSummary,
            normalizedValue: evidenceSummary.toLowerCase(),
            sourceType: 'public-card-capture',
            sourceId: captureId,
            observedAt: when,
            confidence: 1,
            current: true,
            aiAllowed: false,
            correctionOf: null,
            supersededBy: null,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
        );

        tx.delete(captureRef);
      });
    } catch (error) {
      // Leaving the capture in place is the correct failure mode. Eventarc
      // retries this idempotent function, so a transient error delays the
      // contact rather than losing it or delegating trusted writes to a
      // browser.
      console.error('[onCardCapture] capture_filing_failed', {
        captureRef: opaqueLogRef(captureId),
        ownerRef: opaqueLogRef(ownerUid),
        errorCode: stableErrorCode(error),
      });
      throw error;
    }
  }
);
