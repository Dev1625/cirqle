import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { TierBadge } from '../components/ui/TierBadge';
import { Sparkles, ArrowLeft, Send, Calendar, MessageSquare, Tag, ShieldCheck, AlertTriangle, Save, Clock3, FileText, LockKeyhole } from 'lucide-react';
import { Input } from '../components/ui/Input';
import Markdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';
import { ContactIntelligence } from '../components/contact/ContactIntelligence';
import { ContactCommunicationLoop } from '../components/contact/ContactCommunicationLoop';
import { ContactManagementWorkspace } from '../components/contact/ContactManagementWorkspace';
import { IntroductionSignalsPanel } from '../components/contact/IntroductionSignalsPanel';
import { sendOutreach } from '../lib/integrations/gmail';
import { useComposeShortcut } from '../hooks/useKeyboardShortcuts';
import { isMock } from '../lib/integrations/config';
import { PreviewBadge } from '../components/ui/PreviewBadge';
import {
  generateGroundedJSON,
  groundingDisplay,
  isGroundedInRequiredSources,
  sourceLabelMap,
  type GroundedSource,
  type GroundingPrivacyExclusion,
} from '../lib/grounding';
import { AIProvenance } from '../components/ui/AIProvenance';
import { AISurface } from '../components/ui/AISurface';
import { AICancelledError, type AIResponseMeta } from '../lib/ai';
import {
  OUTREACH_AI_FEATURES,
  openedInMailClientState,
  renderTemplate,
  reviewDraftGrounding,
  selectReplyTarget,
  unresolvedTemplateVariables,
  userConfirmedSendState,
  validatedGroundedTags,
  type DraftGroundingIssue,
} from '../lib/outreachWorkflow';
import {
  saveContactProfile,
} from '../lib/contactManagement';
import {
  buildMailtoUrl,
  isContactAIEligible,
  localDateFromISODate,
  managedContactFromRecord,
  normalizeHttpsUrl,
} from '../lib/contactManagementCore';
import {
  encryptSensitiveNote,
  isSensitiveNote,
  sensitiveNoteRecord,
  SensitiveNoteError,
  type SensitiveNoteEnvelopeV1,
  type SensitiveNoteEnvelopeV2,
} from '../lib/sensitiveNotes';
import {
  LockedSensitiveNote,
  SensitiveNoteOption,
} from '../components/privacy/SensitiveNote';
import {
  buildRelationshipTimeline,
  timelineDate,
  timelineFreshness,
  type RelationshipTimelineEvent,
  type RelationshipTimelineKind,
} from '../lib/relationshipTimeline';
import { listContactFacts } from '../lib/factLedger';
import {
  factsToGroundedSources,
  type TemporalFact,
} from '../lib/factLedgerCore';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { queueSourceFacts } from '../lib/sourceFacts';
import {
  meetingSourceFacts,
  noteSourceFacts,
} from '../lib/sourceFactsCore';

interface DraftState {
  subject: string;
  body: string;
  usedSourceIds: string[];
  sourceLabels: Record<string, string>;
  unsupportedAssumptions: string[];
  privacyExclusions: GroundingPrivacyExclusion[];
  generatedAt: string;
  sourceObservedAt?: Record<string, string>;
  consideredSourceCount?: number;
  dataFreshThrough?: string | null;
  generation?: AIResponseMeta;
  evidenceSources: GroundedSource[];
  groundingIssues: DraftGroundingIssue[];
  unresolvedVariables: string[];
  templateId: string | null;
  generatedBy: 'ai' | 'template';
  quality: 'quick' | 'premium' | 'manual';
}

interface InlineProvenanceState {
  feature: string;
  sourceIds: string[];
  sourceLabels: Record<string, string>;
  unsupportedAssumptions: string[];
  privacyExclusions: GroundingPrivacyExclusion[];
  generatedAt: string;
  sourceObservedAt?: Record<string, string>;
  consideredSourceCount?: number;
  dataFreshThrough?: string | null;
  generation?: AIResponseMeta;
}

function timestampMillis(value: any): number {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function timestampLabel(value: any): string {
  const millis = timestampMillis(value);
  return millis
    ? new Date(millis).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Saved memory';
}

function timelineExactLabel(value: Date | null): string {
  if (!value) return 'Date unavailable';
  return value.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function timelineDayLabel(value: Date | null): string {
  if (!value) return 'Undated records';
  const freshness = timelineFreshness(value);
  const exact = value.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return freshness === 'Today' || freshness === 'Yesterday'
    ? `${freshness} · ${exact}`
    : exact;
}

function timelineKindTone(kind: RelationshipTimelineKind): string {
  if (kind === 'meeting') return 'border-[#617672] bg-[#F0F3EC] text-[#405856]';
  if (kind === 'reply') return 'border-emerald-300 bg-emerald-50 text-emerald-800';
  if (kind === 'sensitive-note') return 'border-violet-300 bg-violet-50 text-violet-900';
  if (kind === 'provider-send') return 'border-[#66715F] bg-[#F0F3EC] text-[#4B5546]';
  if (kind === 'user-confirmed-send') return 'border-sky-300 bg-sky-50 text-sky-900';
  if (kind === 'mail-client-opened' || kind === 'legacy-outreach') {
    return 'border-amber-300 bg-amber-50 text-amber-900';
  }
  if (kind === 'follow-up') return 'border-orange-300 bg-orange-50 text-orange-900';
  return 'border-ink/20 bg-paper text-ink';
}

function TimelineKindIcon({ kind }: { kind: RelationshipTimelineKind }) {
  if (kind === 'meeting') return <Calendar size={15} aria-hidden="true" />;
  if (kind === 'reply') return <MessageSquare size={15} aria-hidden="true" />;
  if (kind === 'sensitive-note') return <LockKeyhole size={15} aria-hidden="true" />;
  if (kind === 'provider-send') return <ShieldCheck size={15} aria-hidden="true" />;
  if (
    kind === 'user-confirmed-send' ||
    kind === 'mail-client-opened' ||
    kind === 'legacy-outreach' ||
    kind === 'outreach'
  ) {
    return <Send size={15} aria-hidden="true" />;
  }
  if (kind === 'follow-up') return <Clock3 size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
}

function sameLegacySensitiveEnvelope(
  value: unknown,
  expected: SensitiveNoteEnvelopeV1,
): boolean {
  const candidate = value as Partial<SensitiveNoteEnvelopeV1> | null;
  return Boolean(
    candidate &&
      candidate.schemaVersion === expected.schemaVersion &&
      candidate.algorithm === expected.algorithm &&
      candidate.kdf === expected.kdf &&
      candidate.iterations === expected.iterations &&
      candidate.salt === expected.salt &&
      candidate.iv === expected.iv &&
      candidate.ciphertext === expected.ciphertext,
  );
}

async function migrateSensitiveNoteEnvelope(
  uid: string,
  noteId: string,
  expected: SensitiveNoteEnvelopeV1,
  replacement: SensitiveNoteEnvelopeV2,
): Promise<void> {
  const noteRef = doc(db, `users/${uid}/notes/${noteId}`);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(noteRef);
    const data = snapshot.data();
    if (
      !snapshot.exists() ||
      data?.userId !== uid ||
      data?.sensitive !== true ||
      data?.content !== null ||
      data?.aiAllowed !== false ||
      !sameLegacySensitiveEnvelope(data?.encryptedContent, expected)
    ) {
      throw new Error('sensitive_note_changed');
    }
    transaction.update(noteRef, {
      encryptedContent: replacement,
      encryptionMigratedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

function TimelineProvenance({
  event,
}: {
  event: RelationshipTimelineEvent<Record<string, any>>;
}) {
  const provenance = event.provenance;
  return (
    <details className="mt-3 border-t border-ink/10 pt-3 text-xs text-subtle">
      <summary className="min-h-11 cursor-pointer py-3 font-mono text-[10px] font-bold uppercase tracking-widest text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
        Evidence &amp; provenance
      </summary>
      <dl className="grid gap-2 pb-2 sm:grid-cols-[130px_minmax(0,1fr)]">
        <dt className="font-mono text-[9px] uppercase tracking-widest">Recorded from</dt>
        <dd>{provenance.label}</dd>
        <dt className="font-mono text-[9px] uppercase tracking-widest">Source record</dt>
        <dd className="break-all font-mono">{provenance.sourceId}</dd>
        {provenance.provider && (
          <>
            <dt className="font-mono text-[9px] uppercase tracking-widest">Provider</dt>
            <dd>{provenance.provider}</dd>
          </>
        )}
        {provenance.threadId && (
          <>
            <dt className="font-mono text-[9px] uppercase tracking-widest">Thread</dt>
            <dd className="break-all font-mono">{provenance.threadId}</dd>
          </>
        )}
        {provenance.replySourceId && (
          <>
            <dt className="font-mono text-[9px] uppercase tracking-widest">Reply evidence</dt>
            <dd className="break-all font-mono">{provenance.replySourceId}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function RelationshipTimelineItem({
  event,
  onConfirmSent,
  uid,
}: {
  event: RelationshipTimelineEvent<Record<string, any>>;
  onConfirmSent: (outreachId: string) => void;
  uid: string;
}) {
  const item = event.record;
  const exactDate = timelineExactLabel(event.happenedAt);
  const freshness = timelineFreshness(event.happenedAt);

  return (
    <article
      aria-labelledby={`${event.id}-title`}
      className="relative rounded-card border border-ink/15 bg-white p-5 shadow-[0_1px_0_rgba(26,26,26,0.03)] before:absolute before:-left-[29px] before:top-7 before:h-3 before:w-3 before:rounded-full before:border-2 before:border-[#8C7A65] before:bg-white"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex min-h-7 items-center gap-1.5 border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${timelineKindTone(event.kind)}`}
            >
              <TimelineKindIcon kind={event.kind} />
              <span id={`${event.id}-title`}>{event.label}</span>
            </span>
            {event.recordType === 'outreach' && item.status && (
              <span className="border border-ink/15 bg-white px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-subtle">
                Record status: {item.status}
              </span>
            )}
          </div>
          {event.recordType === 'outreach' && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-subtle">
              {[item.type || 'Outreach', item.channel].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="shrink-0 text-left sm:text-right">
          {event.happenedAt ? (
            <time
              dateTime={event.happenedAt.toISOString()}
              className="block font-mono text-[10px] font-bold uppercase tracking-widest text-ink"
            >
              {exactDate}
            </time>
          ) : (
            <span className="block font-mono text-[10px] font-bold uppercase tracking-widest text-amber-800">
              Date unavailable
            </span>
          )}
          <span className="mt-1 block font-mono text-[9px] uppercase tracking-widest text-subtle">
            {freshness}
          </span>
        </div>
      </div>

      {event.recordType === 'note' ? (
        <div className="mt-4 space-y-3 border-l-2 border-ink/15 pl-4">
          {isSensitiveNote(item, {
            uid,
            noteId: event.provenance.sourceId,
          }) ? (
            <LockedSensitiveNote
              envelope={item.encryptedContent}
              uid={uid}
              noteId={event.provenance.sourceId}
              onMigrate={(expected, replacement) =>
                migrateSensitiveNoteEnvelope(
                  uid,
                  event.provenance.sourceId,
                  expected,
                  replacement,
                )
              }
            />
          ) : item.sensitive ? (
            <p role="alert" className="text-xs text-red-700">
              This encrypted note is malformed and was withheld. Cirqle will not guess at its contents.
            </p>
          ) : item.content ? (
            <div className="markdown-body prose-sm whitespace-pre-wrap font-mono leading-relaxed">
              <Markdown>{item.content}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-subtle">No note text was stored with this record.</p>
          )}
          {!item.sensitive && item.aiSummary && (
            <div className="border border-ink/10 bg-paper/60 p-3">
              <p className="mb-1 font-mono text-[9px] font-bold uppercase tracking-widest text-subtle">
                AI summary
              </p>
              <div className="markdown-body prose-sm font-mono leading-relaxed">
                <Markdown>{item.aiSummary}</Markdown>
              </div>
            </div>
          )}
          {!item.sensitive && item.aiSummaryGrounding && (
            <AIProvenance
              sourceIds={item.aiSummaryGrounding.usedSourceIds || []}
              sourceLabels={item.aiSummaryGrounding.sourceLabels || {}}
              unsupportedAssumptions={item.aiSummaryGrounding.unsupportedAssumptions || []}
              privacyExclusions={item.aiSummaryGrounding.privacyExclusions || []}
              generatedAt={item.aiSummaryGrounding.generatedAt}
              sourceObservedAt={item.aiSummaryGrounding.sourceObservedAt}
              consideredSourceCount={item.aiSummaryGrounding.consideredSourceCount}
              dataFreshThrough={item.aiSummaryGrounding.dataFreshThrough}
              generation={item.aiSummaryGrounding.generation}
            />
          )}
          {!item.sensitive && item.aiProvenance && (
            <AIProvenance
              sourceIds={item.aiProvenance.sourceIds || []}
              sourceLabels={item.aiProvenance.sourceLabels || {}}
              unsupportedAssumptions={item.aiProvenance.unsupportedAssumptions || []}
              privacyExclusions={item.aiProvenance.privacyExclusions || []}
              generatedAt={item.aiProvenance.generatedAt}
              sourceObservedAt={item.aiProvenance.sourceObservedAt}
              consideredSourceCount={item.aiProvenance.consideredSourceCount}
              dataFreshThrough={item.aiProvenance.dataFreshThrough}
              generation={item.aiProvenance.generation}
            />
          )}
        </div>
      ) : (
        <div className="mt-4">
          {item.subject && (
            <p className="font-serif text-lg font-bold">{item.subject}</p>
          )}
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            {event.provenance.label}
          </p>
          {item.body && (
            <details className="mt-3 border-l-2 border-ink/10 pl-3">
              <summary className="flex min-h-9 cursor-pointer list-none items-center font-mono text-[9px] font-bold uppercase tracking-widest text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                View saved message or thread
              </summary>
              <p className="max-h-80 overflow-y-auto whitespace-pre-wrap pb-2 font-mono text-xs leading-relaxed text-ink/80">
                {String(item.body).slice(0, 20_000)}
              </p>
            </details>
          )}
          {item.aiSummary && (!item.replyEvidence || event.kind === 'reply') && (
            <div className="markdown-body prose-sm mt-3 font-mono leading-relaxed text-ink/80">
              <Markdown>{item.aiSummary}</Markdown>
            </div>
          )}
          {event.kind === 'reply' && item.replyProvenance && (
            <div className="mt-3">
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-subtle">
                Reply analysis evidence
              </p>
              <AIProvenance
                sourceIds={item.replyProvenance.sourceIds || []}
                sourceLabels={item.replyProvenance.sourceLabels || {}}
                unsupportedAssumptions={item.replyProvenance.unsupportedAssumptions || []}
                privacyExclusions={item.replyProvenance.privacyExclusions || []}
                generatedAt={item.replyProvenance.generatedAt}
                sourceObservedAt={item.replyProvenance.sourceObservedAt}
                consideredSourceCount={item.replyProvenance.consideredSourceCount}
                dataFreshThrough={item.replyProvenance.dataFreshThrough}
                generation={item.replyProvenance.generation}
                className="mt-2"
              />
            </div>
          )}
          {item.nextAction && (!item.replyEvidence || event.kind === 'reply') && (
            <div className="mt-3 border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest">
                Suggested next action
              </span>
              <p className="mt-1">{item.nextAction}</p>
            </div>
          )}
          {event.dueAt && (
            <div className="mt-3 flex items-start gap-2 text-xs text-subtle">
              <Calendar size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Follow-up due{' '}
                <time dateTime={event.dueAt.toISOString()}>
                  {event.dueAt.toLocaleDateString()}
                </time>{' '}
                · {timelineFreshness(event.dueAt)}
              </span>
            </div>
          )}
          {item.status === 'Opened in Mail Client' && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-4">
              <span className="text-xs text-subtle">
                Delivery is still unconfirmed. Did you actually send it?
              </span>
              <Button type="button" size="sm" onClick={() => onConfirmSent(item.id)}>
                Confirm Sent
              </Button>
            </div>
          )}
          {event.kind !== 'reply' && item.aiProvenance && (
            <AIProvenance
              sourceIds={item.aiProvenance.sourceIds || []}
              sourceLabels={item.aiProvenance.sourceLabels || {}}
              unsupportedAssumptions={item.aiProvenance.unsupportedAssumptions || []}
              privacyExclusions={item.aiProvenance.privacyExclusions || []}
              generatedAt={item.aiProvenance.generatedAt}
              sourceObservedAt={item.aiProvenance.sourceObservedAt}
              consideredSourceCount={item.aiProvenance.consideredSourceCount}
              dataFreshThrough={item.aiProvenance.dataFreshThrough}
              generation={item.aiProvenance.generation}
              className="mt-3"
            />
          )}
        </div>
      )}

      <TimelineProvenance event={event} />
    </article>
  );
}

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const gmailPreview = isMock();
  const composeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [contact, setContact] = useState<any>(null);
  const [notes, setNotes] = useState<any[]>([]);
  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [outreachesLoaded, setOutreachesLoaded] = useState(false);
  const [notesLoadError, setNotesLoadError] = useState<string | null>(null);
  const [outreachesLoadError, setOutreachesLoadError] = useState<string | null>(null);
  const timelineLoadError = notesLoadError || outreachesLoadError;
  const [templates, setTemplates] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>({});
  const [facts, setFacts] = useState<TemporalFact[]>([]);
  
  // Note/Action Tab State
  const [activeTab, setActiveTab] = useState<'note' | 'meeting' | 'reply' | 'parse'>('note');
  
  // Tab-specific form states
  const [newNote, setNewNote] = useState('');
  const [sensitiveNote, setSensitiveNote] = useState(false);
  const [sensitiveNotePassphrase, setSensitiveNotePassphrase] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [meetingData, setMeetingData] = useState({ date: new Date().toISOString().split('T')[0], discussed: '', promised: '', nextSteps: '', followupDate: '' });
  const [externalOutreach, setExternalOutreach] = useState({
    date: new Date().toISOString().split('T')[0],
    subject: '',
    thread: '',
    responseReceived: false,
  });
  const [isSavingExternalOutreach, setIsSavingExternalOutreach] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [selectedReplyTargetId, setSelectedReplyTargetId] = useState('');
  const [conversationLog, setConversationLog] = useState('');
  const [inlineProvenance, setInlineProvenance] = useState<InlineProvenanceState | null>(null);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingTask, setProcessingTask] = useState<
    'reply' | 'tags' | 'draft' | null
  >(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  
  // Drafting Outreach State
  const [isDrafting, setIsDrafting] = useState(false);
  const [draftQuestions, setDraftQuestions] = useState<string[]>([]);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [currentDraft, setCurrentDraft] = useState<DraftState | null>(null);
  const [isDelivering, setIsDelivering] = useState(false);
  const [openedOutreachId, setOpenedOutreachId] = useState<string | null>(null);
  const [providerOutreachId, setProviderOutreachId] = useState<string | null>(
    null,
  );
  const [templateSaveName, setTemplateSaveName] = useState('');

  useEffect(() => {
    if (!user || !id) return;
    setNotesLoaded(false);
    setOutreachesLoaded(false);
    setNotesLoadError(null);
    setOutreachesLoadError(null);
    const unsub = onSnapshot(doc(db, `users/${user.uid}/contacts/${id}`), (docSnap) => {
      if (docSnap.exists()) {
        setContact({ id: docSnap.id, ...docSnap.data() });
      } else {
        navigate('/app/directory');
      }
    }, (error) => handleFirestoreError(error, 'get', `users/${user.uid}/contacts/${id}`));

    const q = query(collection(db, `users/${user.uid}/notes`), where('userId', '==', user.uid));
    const unsubNotes = onSnapshot(q, (snapshot) => {
      const allNotes = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      const myNotes = allNotes.filter((n: any) => n.contactId === id).sort((a: any, b: any) => b.createdAt?.toMillis() - a.createdAt?.toMillis());
      setNotes(myNotes);
      setNotesLoaded(true);
      setNotesLoadError(null);
    }, (error) => {
      setNotesLoaded(true);
      setNotesLoadError('Notes could not be loaded. Refresh before relying on this timeline.');
      handleFirestoreError(error, 'list', `users/${user.uid}/notes`);
    });

    const qOutreaches = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsubOutreaches = onSnapshot(qOutreaches, (snapshot) => {
      const allOutreaches = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      const myOutreaches = allOutreaches
        .filter((o: any) => o.contactId === id)
        .sort(
          (a: any, b: any) =>
            Math.max(
              timestampMillis(b.sentAt),
              timestampMillis(b.openedAt),
              timestampMillis(b.updatedAt),
            ) -
            Math.max(
              timestampMillis(a.sentAt),
              timestampMillis(a.openedAt),
              timestampMillis(a.updatedAt),
            ),
        );
      setOutreaches(myOutreaches);
      setOutreachesLoaded(true);
      setOutreachesLoadError(null);
    }, (error) => {
      setOutreachesLoaded(true);
      setOutreachesLoadError('Outreach history could not be loaded. Refresh before relying on this timeline.');
      handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`);
    });

    const qTemplates = query(collection(db, `users/${user.uid}/templates`), where('userId', '==', user.uid));
    const unsubTemplates = onSnapshot(qTemplates, (snapshot) => {
      setTemplates(
        snapshot.docs
          .map((templateDoc) => ({ id: templateDoc.id, ...templateDoc.data() }))
          .sort((a: any, b: any) => timestampMillis(b.updatedAt || b.createdAt) - timestampMillis(a.updatedAt || a.createdAt)),
      );
    }, (error) => handleFirestoreError(error, 'list', `users/${user.uid}/templates`));

    void getDoc(doc(db, `users/${user.uid}`)).then((profileSnapshot) => {
      setProfile(profileSnapshot.data() || {});
    }).catch((error) => handleFirestoreError(error, 'get', `users/${user.uid}`));
    void listContactFacts(user.uid, id)
      .then(setFacts)
      .catch(() => setFacts([]));

    return () => { unsub(); unsubNotes(); unsubOutreaches(); unsubTemplates(); };
  }, [user, id, navigate]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );

  const templateContext = useMemo(
    () => ({
      contactName: contact?.name,
      company: contact?.company,
      role: contact?.role,
      userName: profile?.name,
      userRole: profile?.role,
      goal: draftAnswers[0],
      ask: draftAnswers[1],
    }),
    [contact, profile, draftAnswers],
  );

  const templatePreview = useMemo(
    () => selectedTemplate ? renderTemplate(selectedTemplate, templateContext) : null,
    [selectedTemplate, templateContext],
  );
  const managedContact = useMemo(
    () => (contact && id ? managedContactFromRecord(id, contact) : null),
    [contact, id],
  );
  const safeContactEmail = managedContact?.email || '';
  const safeLinkedInUrl = normalizeHttpsUrl(
    managedContact?.linkedinUrl,
  );
  const contactAIAllowed = Boolean(
    managedContact && isContactAIEligible(managedContact),
  );
  const relationshipTimeline = useMemo(
    () =>
      buildRelationshipTimeline({ notes, outreaches }) as Array<
        RelationshipTimelineEvent<Record<string, any>>
      >,
    [notes, outreaches],
  );
  const relationshipTimelineGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        label: string;
        events: Array<RelationshipTimelineEvent<Record<string, any>>>;
      }
    >();
    relationshipTimeline.forEach((event) => {
      const date = event.happenedAt;
      const key = date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : 'undated';
      const group = groups.get(key) || {
        label: timelineDayLabel(date),
        events: [],
      };
      group.events.push(event);
      groups.set(key, group);
    });
    return Array.from(groups.entries()).map(([key, group]) => ({
      key,
      ...group,
    }));
  }, [relationshipTimeline]);

  useEffect(
    () => () => {
      aiAbortRef.current?.abort();
    },
    [],
  );

  const beginAIRequest = (
    task: 'reply' | 'tags' | 'draft',
  ): AbortController => {
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setProcessingTask(task);
    setIsProcessing(true);
    return controller;
  };

  const finishAIRequest = (controller: AbortController) => {
    if (aiAbortRef.current !== controller) return;
    aiAbortRef.current = null;
    setProcessingTask(null);
    setIsProcessing(false);
  };

  const cancelAIRequest = () => {
    aiAbortRef.current?.abort();
  };

  const closeDrafting = () => {
    if (processingTask === 'draft') cancelAIRequest();
    setIsDrafting(false);
    setCurrentDraft(null);
    setOpenedOutreachId(null);
    setProviderOutreachId(null);
    setTemplateSaveName('');
    window.requestAnimationFrame(() => composeButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!isDrafting) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDelivering) closeDrafting();
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]',
        ),
      ).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[autofocus], button, input, select, textarea')?.focus();
    });
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDrafting, isDelivering]);

  const contactSource = (): GroundedSource | null =>
    contactAIAllowed
      ? {
          id: `contact-${id}`,
          kind: 'contact',
          label: 'Contact profile',
          text: JSON.stringify({
            name: contact?.name || '',
            role: contact?.role || '',
            company: contact?.company || '',
            location: contact?.location || '',
            summary: contact?.summary || '',
            tags: Array.isArray(contact?.tags) ? contact.tags : [],
          }),
        }
      : null;

  const profileSource = (): GroundedSource | null => {
    const text = JSON.stringify({
      name: profile?.name || '',
      role: profile?.role || '',
      company: profile?.company || '',
      bio: profile?.bio || '',
    });
    return Object.values(profile || {}).some(Boolean)
      ? { id: 'user-profile', kind: 'profile', label: 'Your profile', text }
      : null;
  };

  const savedMemorySources = (): GroundedSource[] => {
    const factSources =
      contactAIAllowed && id ? factsToGroundedSources(id, facts) : [];
    const noteSources = notes
      .filter(
        (note) =>
          note.sensitive !== true &&
          note.aiAllowed !== false &&
          (!Array.isArray(note.aiProvenance?.unsupportedAssumptions) ||
            note.aiProvenance.unsupportedAssumptions.length === 0),
      )
      .slice(0, 15)
      .map((note) => {
        const isMeeting = /^\s*\*\*Meeting on/i.test(note.content || '');
        return {
          id: `note-${note.id}`,
          kind: isMeeting ? 'meeting' as const : 'note' as const,
          label: `${isMeeting ? 'Meeting' : 'Note'} · ${timestampLabel(note.createdAt)}`,
          text: String(note.content || ''),
          observedAt: timestampMillis(note.createdAt)
            ? new Date(timestampMillis(note.createdAt)).toISOString()
            : null,
        };
      });

    const verifiedOutreachSources = outreaches
      .filter(
        (outreach) =>
          outreach.verification === 'provider-verified' ||
          outreach.verification === 'user-confirmed',
      )
      .slice(0, 10)
      .map((outreach) => ({
        id: `outreach-${outreach.id}`,
        kind: 'outreach' as const,
        label: `Outreach · ${timestampLabel(outreach.sentAt || outreach.updatedAt)}`,
        text: JSON.stringify({
          subject: outreach.subject || '',
          body: outreach.body || '',
          verification: outreach.verification,
        }),
        observedAt: timestampMillis(outreach.sentAt)
          ? new Date(timestampMillis(outreach.sentAt)).toISOString()
          : null,
      }));

    return [...factSources, ...noteSources, ...verifiedOutreachSources];
  };

  const buildDraftSources = (
    includeExistingDraft = false,
  ): GroundedSource[] => {
    const sources: Array<GroundedSource | null> = [
      contactSource(),
      profileSource(),
      draftAnswers[0]?.trim()
        ? {
            id: 'user-goal',
            kind: 'user-input',
            label: 'Goal you entered',
            text: draftAnswers[0].trim(),
          }
        : null,
      draftAnswers[1]?.trim()
        ? {
            id: 'user-ask',
            kind: 'user-input',
            label: 'Ask you entered',
            text: draftAnswers[1].trim(),
          }
        : null,
      draftAnswers[2]?.trim()
        ? {
            id: 'user-recent-context',
            kind: 'user-input',
            label: 'Recent context you entered',
            text: draftAnswers[2].trim(),
          }
        : null,
      draftAnswers[3]?.trim()
        ? {
            id: 'user-tone',
            kind: 'user-input',
            label: 'Tone you selected',
            text: draftAnswers[3].trim(),
          }
        : null,
      selectedTemplate && templatePreview
        ? {
            id: `template-${selectedTemplate.id}`,
            kind: 'user-input',
            label: `Template · ${selectedTemplate.name}`,
            text: JSON.stringify({
              name: selectedTemplate.name,
              subject: templatePreview.subject,
              body: templatePreview.body,
            }),
            factual: false,
          }
        : null,
      includeExistingDraft && currentDraft
        ? {
            id: 'draft-to-improve',
            kind: 'user-input',
            label: 'Draft to improve',
            text: JSON.stringify({
              subject: currentDraft.subject,
              body: currentDraft.body,
            }),
            factual: false,
          }
        : null,
      ...savedMemorySources(),
    ];
    return sources.filter((source): source is GroundedSource => Boolean(source));
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !id || !newNote.trim()) return;
    const noteText = newNote.trim();
    const wasSensitive = sensitiveNote;
    const notePassphrase = sensitiveNotePassphrase;
    setIsSavingNote(true);
    try {
      const noteRef = doc(collection(db, `users/${user.uid}/notes`));
      const privacyFields = wasSensitive
          ? sensitiveNoteRecord(
              await encryptSensitiveNote(
                noteText,
                notePassphrase,
                { uid: user.uid, noteId: noteRef.id },
              ),
              { uid: user.uid, noteId: noteRef.id },
            )
        : {
            content: noteText,
            sensitive: false,
            aiAllowed: true,
          };

      // Clear immediately once local validation/encryption succeeds. If the
      // write fails, the exact draft is restored below.
      setNewNote('');
      setSensitiveNote(false);
      setSensitiveNotePassphrase('');
      const noteBatch = writeBatch(db);
      const observedAt = new Date();
      const factIds = wasSensitive
        ? []
        : queueSourceFacts(noteBatch, {
            uid: user.uid,
            contactId: id,
            sourceType: 'note',
            sourceId: noteRef.id,
            observedAt,
            facts: noteSourceFacts(noteText),
            aiAllowed: contactAIAllowed,
          });
      noteBatch.set(noteRef, {
        noteSchemaVersion: 2,
        userId: user.uid,
        contactId: id,
        recordType: 'note',
        ...privacyFields,
        aiAllowed: wasSensitive ? false : contactAIAllowed,
        source: wasSensitive ? 'sensitive-note' : 'quick-note',
        privacySourceType: 'note',
        sourceId: noteRef.id,
        observedAt,
        factIds,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await noteBatch.commit();
      toast(
        wasSensitive ? 'Encrypted note saved.' : 'Note saved.',
        'success',
        8_000,
        {
          label: 'Undo',
          onClick: async () => {
            try {
              const response = await authenticatedFetch(
                '/api/contacts/source-delete',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contactId: id,
                    noteId: noteRef.id,
                  }),
                },
              );
              if (!response.ok) {
                throw new Error('source_delete_failed');
              }
              toast('Note and its linked memory were removed.', 'info');
            } catch {
              toast(
                'The note could not be removed. Open the timeline and try again.',
                'error',
              );
            }
          },
        },
      );
    } catch (err: any) {
       setNewNote(noteText);
       setSensitiveNote(wasSensitive);
       setSensitiveNotePassphrase(notePassphrase);
       if (err instanceof SensitiveNoteError) {
         toast(err.message, 'error');
       } else {
         handleFirestoreError(err, 'create', `users/${user.uid}/notes`);
       }
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleLogMeeting = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id) return;
     try {
       const meetingAt = localDateFromISODate(meetingData.date);
       if (!meetingAt) {
         toast('Choose a valid meeting date.', 'error');
         return;
       }
       const followupAt = meetingData.followupDate
         ? localDateFromISODate(meetingData.followupDate)
         : null;
       if (meetingData.followupDate && !followupAt) {
         toast('Choose a valid follow-up date.', 'error');
         return;
       }
       const discussed = meetingData.discussed.trim().slice(0, 20_000);
       const promised = meetingData.promised.trim().slice(0, 20_000);
       const nextSteps = meetingData.nextSteps.trim().slice(0, 20_000);
       const content = `**Meeting on ${meetingData.date}**\n- **Discussed:** ${discussed}\n- **Promised:** ${promised}\n- **Next Steps:** ${nextSteps}`;
       const meetingRef = doc(collection(db, `users/${user.uid}/notes`));
       const meetingBatch = writeBatch(db);
       const factIds = queueSourceFacts(meetingBatch, {
         uid: user.uid,
         contactId: id,
         sourceType: 'meeting',
         sourceId: meetingRef.id,
         observedAt: meetingAt,
         facts: meetingSourceFacts({
           date: meetingData.date,
           discussed,
           promised,
           nextSteps,
         }),
         aiAllowed: contactAIAllowed,
       });
       meetingBatch.set(meetingRef, {
         noteSchemaVersion: 2,
         userId: user.uid,
         contactId: id,
         content,
         recordType: 'meeting',
         source: 'meeting-log',
         privacySourceType: 'meeting',
         sourceId: meetingRef.id,
         sensitive: false,
         aiAllowed: contactAIAllowed,
         occurredAt: meetingAt,
         meetingAt,
         observedAt: meetingAt,
         factIds,
         createdAt: serverTimestamp(),
         updatedAt: serverTimestamp(),
       });

       if (meetingData.followupDate) {
         // Create a pending outreach to show up on the calendar
         const followupRef = doc(
           collection(db, `users/${user.uid}/outreaches`),
         );
         meetingBatch.set(followupRef, {
           userId: user.uid,
           contactId: id,
           type: 'Follow-up',
           subject: 'Scheduled Follow-up',
           status: 'Pending Follow-Up',
           nextFollowUpDate: followupAt,
           sentAt: null,
           createdAt: serverTimestamp(),
           updatedAt: serverTimestamp(),
           channel: null,
           verification: 'none',
           responseReceived: null,
           dateOfResponse: null,
           meetingHeld: null,
           meetingDate: null,
           nextAction: null,
           referralGenerated: null,
           applicationLinked: null,
           notes: null,
           aiSummary: null
         });
       }
       meetingBatch.update(
         doc(db, `users/${user.uid}/contacts/${id}`),
         {
           lastContactedAt: meetingAt,
           updatedAt: serverTimestamp(),
         },
       );
       await meetingBatch.commit();

       setMeetingData({ date: new Date().toISOString().split('T')[0], discussed: '', promised: '', nextSteps: '', followupDate: '' });
       setActiveTab('note');
       toast('Meeting filed with its source-backed memory.', 'success');
     } catch(err: any) {
       handleFirestoreError(err, 'create', `users/${user.uid}/notes`);
     }
  };

  const handleLogExternalOutreach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !id || !externalOutreach.thread.trim()) return;
    const sentAt = localDateFromISODate(externalOutreach.date);
    if (!sentAt) {
      toast('Choose a valid sent date.', 'error');
      return;
    }

    setIsSavingExternalOutreach(true);
    try {
      const outreachRef = doc(collection(db, `users/${user.uid}/outreaches`));
      const outreachBatch = writeBatch(db);
      const replied = externalOutreach.responseReceived;
      outreachBatch.set(outreachRef, {
        userId: user.uid,
        contactId: id,
        contactName: contact.name || null,
        type: 'Email',
        channel: 'email',
        subject: externalOutreach.subject.trim().slice(0, 500),
        body: externalOutreach.thread.trim().slice(0, 70_000),
        status: replied ? 'Responded' : 'Sent (User Confirmed)',
        verification: 'user-confirmed',
        deliveryMode: 'manual',
        sentAt,
        userConfirmedAt: serverTimestamp(),
        responseReceived: replied ? 'Yes' : 'No',
        dateOfResponse: replied ? sentAt : null,
        ...(replied
          ? {
              replyEvidence: {
                occurredAt: sentAt,
                source: 'user',
                sourceRecordId: null,
                provider: null,
                threadId: null,
                messageId: null,
                eventId: null,
              },
            }
          : {}),
        notes: 'Pasted from outreach sent outside Cirqle.',
        generatedBy: 'manual',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (sentAt.getTime() >= timestampMillis(contact.lastContactedAt)) {
        outreachBatch.update(doc(db, `users/${user.uid}/contacts/${id}`), {
          lastContactedAt: sentAt,
          updatedAt: serverTimestamp(),
        });
      }
      await outreachBatch.commit();
      setExternalOutreach({
        date: new Date().toISOString().split('T')[0],
        subject: '',
        thread: '',
        responseReceived: false,
      });
      setActiveTab('note');
      toast(
        replied
          ? 'Email thread added to outreach with its reply.'
          : 'External email added to outreach.',
        'success',
      );
    } catch (err: any) {
      handleFirestoreError(err, 'create', `users/${user.uid}/outreaches`);
    } finally {
      setIsSavingExternalOutreach(false);
    }
  };

  const handleProcessReply = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id || !replyText.trim() || !selectedReplyTargetId) return;
     if (!contactAIAllowed) {
       toast(
         'AI is disabled for this contact. You can still save a regular note or compose from a template without AI.',
         'info',
       );
       return;
     }
     const selectedOutreach =
       selectedReplyTargetId === 'unlinked'
         ? null
         : selectReplyTarget(outreaches, selectedReplyTargetId);
     if (selectedReplyTargetId !== 'unlinked' && !selectedOutreach) {
       toast('That outreach is no longer available. Select a thread again.', 'error');
       return;
     }
     setInlineProvenance(null);
     const controller = beginAIRequest('reply');
     try {
        const replySource: GroundedSource = {
          id: 'pasted-reply',
          kind: 'reply',
          label: 'Reply you pasted',
          text: replyText.trim(),
        };
        const targetSource: GroundedSource | null = selectedOutreach
          ? {
              id: `outreach-${selectedOutreach.id}`,
              kind: 'outreach',
              label: `Selected thread · ${selectedOutreach.subject || 'No subject'}`,
              text: JSON.stringify({
                subject: selectedOutreach.subject || '',
                body: selectedOutreach.body || '',
                status: selectedOutreach.status || '',
              }),
            }
          : null;
        const sources = [replySource, contactSource(), targetSource].filter(
          (source): source is GroundedSource => Boolean(source),
        );
         const grounded = await generateGroundedJSON<{
          summary?: string;
          suggestedAction?: string;
        }>({
          task: `Summarize the pasted reply from ${contact.name} in one or two short sentences and suggest one concrete next action. Do not claim that an action was completed. The selected outreach is linkage context only.`,
          resultSchema:
            '{"summary":"brief factual summary","suggestedAction":"one suggested next step or an empty string"}',
          sources,
          rules: [
            'Base the summary on pasted-reply.',
            'Never infer sentiment, agreement, availability, or a commitment unless the reply explicitly states it.',
          ],
          options: {
            tier: 'reasoning',
            feature: OUTREACH_AI_FEATURES.processReply,
            temperature: 0.1,
            maxTokens: 350,
             signal: controller.signal,
           },
         });
         const display = groundingDisplay(grounded, sources);
         const provenance = {
          feature: OUTREACH_AI_FEATURES.processReply,
          sourceIds: grounded.usedSourceIds,
          sourceLabels: display.sourceLabels,
          unsupportedAssumptions: grounded.unsupportedAssumptions,
          privacyExclusions: grounded.privacyExclusions || [],
          generatedAt: display.generatedAt,
          sourceObservedAt: display.sourceObservedAt,
          consideredSourceCount: display.consideredSourceCount,
          dataFreshThrough: display.dataFreshThrough,
           generation: grounded.generation,
         };
         setInlineProvenance(provenance);
         if (!isGroundedInRequiredSources(grounded, ['pasted-reply'])) {
           toast(
             'The reply summary did not cite the reply you pasted, so nothing was saved or changed.',
             'error',
           );
           return;
         }
         const content = `**Reply Received:** ${grounded.result.summary || 'Reply saved.'}\n**AI Suggestion:** ${grounded.result.suggestedAction || 'Review and choose the next step.'}\n\n*Original:* "${replyText.substring(0, 150)}${replyText.length > 150 ? '...' : ''}"`;
        
        const replyNoteRef = doc(
          collection(db, `users/${user.uid}/notes`),
        );
        const replyObservedAt = new Date();
        await setDoc(replyNoteRef, {
          noteSchemaVersion: 2,
          userId: user.uid,
          contactId: id,
          recordType: 'reply',
          source: 'pasted-reply',
          privacySourceType: 'reply',
          sourceId: replyNoteRef.id,
          content,
          sensitive: false,
          aiAllowed: contactAIAllowed,
          observedAt: replyObservedAt,
          factIds: [],
          replyTargetOutreachId: selectedOutreach?.id || null,
          replyTargetThreadId: selectedOutreach?.threadId || null,
          aiFeature: OUTREACH_AI_FEATURES.processReply,
          aiProvenance: provenance,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const replyNote = replyNoteRef;

        // The user selected this exact record. A general/unlinked reply never
        // mutates an outreach, and there is deliberately no "latest" fallback.
        if (selectedOutreach) {
          await updateDoc(doc(db, `users/${user.uid}/outreaches/${selectedOutreach.id}`), {
            status: 'Responded',
            responseReceived: 'Yes',
            responseSource: 'user-pasted',
            responseThreadId: selectedOutreach.threadId || null,
            dateOfResponse: serverTimestamp(),
            nextAction: grounded.result.suggestedAction || null,
            aiSummary: grounded.result.summary || null,
            replyProvenance: provenance,
            replyEvidence: {
              occurredAt: serverTimestamp(),
              source: 'user',
              sourceRecordId: replyNote.id,
              provider: null,
              threadId: selectedOutreach.threadId || null,
              messageId: null,
              eventId: null,
            },
            updatedAt: serverTimestamp()
          });
        }

        setReplyText('');
        setSelectedReplyTargetId('');
        setActiveTab('note');
        toast(
          selectedOutreach
            ? `Reply linked to "${selectedOutreach.subject || 'selected outreach'}".`
            : 'Reply saved without changing an outreach.',
          'success',
        );
      } catch (err: any) {
         if (err instanceof AICancelledError) {
           toast('Reply processing canceled. Your pasted reply is still here.', 'info');
         } else {
           console.warn('[reply-processing] temporarily unavailable');
           toast("Failed to process that reply. Your text is still here; check AI access and try again.", 'error');
         }
      } finally {
         finishAIRequest(controller);
      }
  };

  const handleParseConversation = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id || !conversationLog.trim()) return;
     if (!contactAIAllowed) {
       toast(
         'AI is disabled for this contact, so the conversation was not sent for tag extraction.',
         'info',
       );
       return;
     }
     setInlineProvenance(null);
     const controller = beginAIRequest('tags');
     try {
        const conversationSource: GroundedSource = {
          id: 'pasted-conversation',
          kind: 'user-input',
          label: 'Conversation you pasted',
          text: conversationLog.trim(),
        };
        const sources = [conversationSource, contactSource()].filter(
          (source): source is GroundedSource => Boolean(source),
        );
        const grounded = await generateGroundedJSON<{
          tags?: Array<{ label?: string; evidenceQuote?: string }>;
        }>({
          task: `Extract short, reusable relationship-memory tags from the pasted conversation with ${contact.name}. Only extract events, needs, interests, or facts explicitly stated in pasted-conversation.`,
          resultSchema:
            '{"tags":[{"label":"optional concise category","evidenceQuote":"an exact short quote of 80 characters or fewer from pasted-conversation"}]}',
          sources,
          rules: [
            'Every tag must be directly supported by pasted-conversation.',
            'Do not turn speculation, a question, or the user’s own plans into a fact about the contact.',
            'Return at most eight tags and omit duplicates.',
          ],
          options: {
            tier: 'fast',
            feature: OUTREACH_AI_FEATURES.extractTags,
            temperature: 0,
            maxTokens: 700,
            signal: controller.signal,
          },
        });
        const display = groundingDisplay(grounded, sources);
        const provenance = {
          feature: OUTREACH_AI_FEATURES.extractTags,
          sourceIds: grounded.usedSourceIds,
          sourceLabels: display.sourceLabels,
          unsupportedAssumptions: grounded.unsupportedAssumptions,
          privacyExclusions: grounded.privacyExclusions || [],
          generatedAt: display.generatedAt,
          sourceObservedAt: display.sourceObservedAt,
          consideredSourceCount: display.consideredSourceCount,
          dataFreshThrough: display.dataFreshThrough,
          generation: grounded.generation,
        };
        setInlineProvenance(provenance);
        const isGrounded = isGroundedInRequiredSources(grounded, [
          'pasted-conversation',
        ]);
        if (!isGrounded) {
          toast(
            'The suggested tags were not grounded tightly enough, so nothing was added.',
            'error',
          );
          return;
        }
        const newTags = validatedGroundedTags(
          grounded.result.tags,
          conversationLog,
        );

        const existingTags = Array.isArray(contact.tags) ? contact.tags : [];
        const addedTags = newTags
          .filter((tag) => !existingTags.includes(tag))
          .slice(0, Math.max(0, 50 - existingTags.length));

        if (addedTags.length > 0) {
           if (!managedContact) {
             throw new Error('The contact profile is unavailable.');
           }
           const tagNoteRef = doc(
             collection(db, `users/${user.uid}/notes`),
           );
           await setDoc(tagNoteRef, {
             noteSchemaVersion: 2,
             userId: user.uid,
             contactId: id,
             recordType: 'ai-tag',
             source: 'ai-tag-extraction',
             privacySourceType: 'user-input',
             sourceId: tagNoteRef.id,
             content: `**AI extracted tags from conversation:** ${addedTags.join(', ')}`,
             sensitive: false,
             aiAllowed: false,
             observedAt: new Date(),
             factIds: [],
             aiFeature: OUTREACH_AI_FEATURES.extractTags,
             aiProvenance: provenance,
             createdAt: serverTimestamp(),
             updatedAt: serverTimestamp(),
           });
           let tagSave;
           try {
             tagSave = await saveContactProfile({
               uid: user.uid,
               contactId: id,
               profile: {
                 ...managedContact,
                 tags: [...existingTags, ...addedTags],
               },
               expectedProfileRevision: managedContact.profileRevision,
             });
           } catch (error) {
             await deleteDoc(
               doc(db, `users/${user.uid}/notes/${tagNoteRef.id}`),
             ).catch(() => undefined);
             throw error;
           }

           toast(
             `Added ${addedTags.length} grounded tag${addedTags.length === 1 ? '' : 's'}.`,
             'success',
             8_000,
             {
               label: 'Undo',
               onClick: async () => {
                 try {
                   await saveContactProfile({
                     uid: user.uid,
                     contactId: id,
                     profile: {
                       ...tagSave.contact,
                       tags: tagSave.contact.tags.filter(
                         (tag) => !addedTags.includes(tag),
                       ),
                     },
                     expectedProfileRevision:
                       tagSave.contact.profileRevision,
                   });
                   await deleteDoc(
                     doc(db, `users/${user.uid}/notes/${tagNoteRef.id}`),
                   );
                   toast('AI tags removed.', 'info');
                 } catch {
                   toast(
                     'The tags could not be undone. Review the contact profile before retrying.',
                     'error',
                   );
                 }
               },
             },
           );
        }
        
        setConversationLog('');
        setActiveTab('note');
        if (addedTags.length === 0) {
          toast(
            newTags.length
              ? 'Every grounded tag was already on this contact.'
              : 'No explicit facts were found, so no tags were added.',
            'info',
          );
        }
      } catch (err) {
         if (err instanceof AICancelledError) {
           toast('Tag extraction canceled. Your pasted conversation is still here.', 'info');
         } else {
           console.warn('[tag-extraction] temporarily unavailable');
           toast("Failed to extract tags. Your pasted conversation is still here; check AI access and try again.", 'error');
         }
      } finally {
         finishAIRequest(controller);
      }
  };

  const startDrafting = async () => {
    setIsDrafting(true);
    setOpenedOutreachId(null);
    setInlineProvenance(null);
    setDraftQuestions([
      "What is the main goal of this message?",
      "Is there a specific 'ask'?",
      "What verified recent context should the draft mention?",
      "What tone should it have? (e.g. warm, brief, professional)"
    ]);
  };

  const generateDraft = async (
    tier: 'fast' | 'draft' = 'fast',
  ) => {
    if (!user || !contact) return;
    if (!contactAIAllowed) {
      toast(
        'AI is disabled for this contact. Choose a template and use it without AI, or re-enable AI in Contact controls.',
        'info',
      );
      return;
    }
    const improving = Boolean(currentDraft);
    const controller = beginAIRequest('draft');
    try {
      const sources = buildDraftSources(improving);
      const grounded = await generateGroundedJSON<{
        subject: string;
        body: string;
      }>({
        task: `${improving ? 'Improve the wording, structure, and concision of draft-to-improve' : `Draft a concise email to ${contact.name}`}. The goal and ask come only from factual user-input sources. Personalize only with supported factual evidence. ${
          selectedTemplate
            ? `Use "template-${selectedTemplate.id}" as a structural and wording constraint; preserve its intent and format while resolving variables.`
            : 'Use a clear greeting, short body, concrete ask when supplied, and sign-off.'
        }`,
        resultSchema:
          '{"subject":"specific subject line","body":"complete plain-text email body"}',
        sources,
        rules: [
          'Never mention an attachment unless a source explicitly says an attachment will be included.',
          'Never imply a prior call, meeting, email, or shared history unless a meeting, reply, or verified outreach source supports it.',
          'Never mention recent news, company activity, an announcement, or something the sender has been following unless a source explicitly states it.',
          'A template is a wording and structure constraint, never factual evidence of an attachment, prior interaction, or recent news.',
          'draft-to-improve is a wording constraint, never factual evidence. Remove any claim in it that is unsupported by factual sources.',
          'Do not invent a sender name when user-profile is absent; use a neutral sign-off.',
          'Keep unresolved template variables visible rather than guessing their values.',
        ],
        options: {
          tier,
          feature:
            tier === 'fast'
              ? OUTREACH_AI_FEATURES.draftQuick
              : OUTREACH_AI_FEATURES.draftPremium,
          temperature: 0.2,
          maxTokens: tier === 'fast' ? 550 : 900,
          signal: controller.signal,
        },
      });
      const subject = String(grounded.result.subject || '').trim();
      const body = String(grounded.result.body || '').trim();
      const display = groundingDisplay(grounded, sources);
      setCurrentDraft({
        subject,
        body,
        usedSourceIds: grounded.usedSourceIds,
        sourceLabels: display.sourceLabels,
        unsupportedAssumptions: grounded.unsupportedAssumptions,
        privacyExclusions: grounded.privacyExclusions || [],
        generatedAt: display.generatedAt,
        sourceObservedAt: display.sourceObservedAt,
        consideredSourceCount: display.consideredSourceCount,
        dataFreshThrough: display.dataFreshThrough,
        generation: grounded.generation,
        evidenceSources: sources,
        groundingIssues: reviewDraftGrounding({
          draft: { subject, body },
          sources,
          unsupportedAssumptions: grounded.unsupportedAssumptions,
        }),
        unresolvedVariables: unresolvedTemplateVariables(subject, body),
        templateId: selectedTemplate?.id || null,
        generatedBy: 'ai',
        quality: tier === 'fast' ? 'quick' : 'premium',
      });
    } catch (err) {
      if (err instanceof AICancelledError) {
        toast(
          'Drafting canceled. Your answers and existing draft are still here.',
          'info',
        );
      } else {
        console.warn('[outreach-drafting] temporarily unavailable');
        toast(
          'Drafting could not finish. Your answers and existing draft are still here; check AI access and try again.',
          'error',
        );
      }
    } finally {
      finishAIRequest(controller);
    }
  };

  const applySelectedTemplate = () => {
    if (!selectedTemplate || !templatePreview) return;
    const sources = buildDraftSources();
    const usedSourceIds = sources
      .filter((source) =>
        source.id === `template-${selectedTemplate.id}` ||
        source.id === `contact-${id}` ||
        source.id === 'user-profile' ||
        source.id.startsWith('user-'),
      )
      .map((source) => source.id);
    setCurrentDraft({
      subject: templatePreview.subject,
      body: templatePreview.body,
      usedSourceIds,
      sourceLabels: sourceLabelMap(sources),
      unsupportedAssumptions: [],
      privacyExclusions: [],
      generatedAt: new Date().toISOString(),
      evidenceSources: sources,
      groundingIssues: reviewDraftGrounding({
        draft: templatePreview,
        sources,
        unsupportedAssumptions: [],
      }),
      unresolvedVariables: templatePreview.unresolvedVariables,
      templateId: selectedTemplate.id,
      generatedBy: 'template',
      quality: 'manual',
    });
  };

  const editCurrentDraft = (field: 'subject' | 'body', value: string) => {
    setCurrentDraft((draft) => {
      if (!draft) return draft;
      const next = { ...draft, [field]: value };
      return {
        ...next,
        groundingIssues: reviewDraftGrounding({
          draft: next,
          sources: draft.evidenceSources,
          unsupportedAssumptions: draft.unsupportedAssumptions,
        }),
        unresolvedVariables: unresolvedTemplateVariables(next.subject, next.body),
      };
    });
  };

  const outreachBase = () => {
    if (!currentDraft || !user || !id) return null;
    return {
      userId: user.uid,
      contactId: id,
      contactName: contact?.name || '',
      type: 'Email',
      channel: 'Email',
      subject: currentDraft.subject,
      body: currentDraft.body,
      nextFollowUpDate: null,
      dateOfResponse: null,
      meetingHeld: false,
      meetingDate: null,
      nextAction: null,
      referralGenerated: false,
      applicationLinked: null,
      notes: null,
      templateId: currentDraft.templateId,
      generatedBy: currentDraft.generatedBy,
      aiFeature:
        currentDraft.generatedBy === 'ai'
          ? currentDraft.quality === 'premium'
            ? OUTREACH_AI_FEATURES.draftPremium
            : OUTREACH_AI_FEATURES.draftQuick
          : null,
      aiProvenance: {
        sourceIds: currentDraft.usedSourceIds,
        sourceLabels: currentDraft.sourceLabels,
        unsupportedAssumptions: currentDraft.unsupportedAssumptions,
        privacyExclusions: currentDraft.privacyExclusions,
        generatedAt: currentDraft.generatedAt,
        sourceObservedAt: currentDraft.sourceObservedAt,
        consideredSourceCount: currentDraft.consideredSourceCount,
        dataFreshThrough: currentDraft.dataFreshThrough,
        generation: currentDraft.generation,
      },
    };
  };

  const canDeliverDraft =
    Boolean(currentDraft?.subject.trim() && currentDraft?.body.trim() && safeContactEmail) &&
    (currentDraft?.groundingIssues.length || 0) === 0 &&
    (currentDraft?.unresolvedVariables.length || 0) === 0;

  const openMailClient = async (existingOutreachId?: string | null) => {
    if (!currentDraft || !contact || !user || !id || !canDeliverDraft) return;
    const mailto = buildMailtoUrl(
      safeContactEmail,
      currentDraft.subject,
      currentDraft.body,
    );
    if (!mailto) {
      toast('Add a valid contact email before opening your mail client.', 'error');
      return;
    }
    setIsDelivering(true);
    try {
      const record = {
        ...outreachBase(),
        ...openedInMailClientState(),
        deliveryMode: 'mailto',
        aiSummary:
          'Draft opened in a mail client. Delivery has not been confirmed.',
        openedAt: serverTimestamp(),
        sentAt: null,
        updatedAt: serverTimestamp(),
      };
      let outreachId = existingOutreachId || null;
      if (outreachId) {
        await updateDoc(
          doc(db, `users/${user.uid}/outreaches/${outreachId}`),
          record,
        );
      } else {
        const outreachRef = await addDoc(
          collection(db, `users/${user.uid}/outreaches`),
          { ...record, createdAt: serverTimestamp() },
        );
        outreachId = outreachRef.id;
      }
      setOpenedOutreachId(outreachId);
      window.location.href = mailto;
      toast(
        'Mail client opened. Confirm only after you actually send the message.',
        'success',
      );
    } catch (err: any) {
      handleFirestoreError(err, 'create', `users/${user.uid}/outreaches`);
    } finally {
      setIsDelivering(false);
    }
  };

  const handleProviderSend = async () => {
    if (!currentDraft || !contact || !user || !id || !canDeliverDraft) return;
    setIsDelivering(true);
    let outreachId: string | null = null;
    let providerConfirmedDelivery = false;
    try {
      if (providerOutreachId) {
        outreachId = providerOutreachId;
      } else {
        const draftRef = await addDoc(
          collection(db, `users/${user.uid}/outreaches`),
          {
            ...outreachBase(),
            status: 'Drafted',
            verification: 'none',
            responseReceived: 'No',
            threadId: null,
            aiSummary: 'Draft saved while provider delivery is attempted.',
            sentAt: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        );
        outreachId = draftRef.id;
        setProviderOutreachId(outreachId);
      }
      const result = await sendOutreach({
        uid: user.uid,
        contactId: id,
        contactName: contact.name || '',
        to: contact.email || '',
        subject: currentDraft.subject,
        body: currentDraft.body,
        outreachId,
      });

      if (!result.verified || !result.threadId) {
        await openMailClient(outreachId);
        return;
      }

      providerConfirmedDelivery = true;
      toast('Sent and verified by the connected provider.', 'success');
      closeDrafting();
    } catch {
      console.warn('[gmail-delivery] temporarily unavailable');
      toast(
        providerConfirmedDelivery
          ? 'Provider confirmed the send. Refresh if the verified receipt is not visible yet.'
          : outreachId
            ? 'Delivery could not be verified. Check Gmail before retrying; this same attempt will be reused so Cirqle cannot silently send it twice.'
            : 'Provider delivery could not start. Your draft is still open.',
        'error',
      );
    } finally {
      setIsDelivering(false);
    }
  };

  const confirmOutreachSent = async (outreachId: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, `users/${user.uid}/outreaches/${outreachId}`), {
        ...userConfirmedSendState(),
        sentAt: serverTimestamp(),
        userConfirmedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        aiSummary: 'Opened in a mail client and later confirmed sent by you.',
      });
      toast('Recorded as sent — confirmed by you.', 'success');
      if (openedOutreachId === outreachId) closeDrafting();
    } catch (err: any) {
      handleFirestoreError(err, 'update', `users/${user.uid}/outreaches/${outreachId}`);
    }
  };

  const saveCurrentDraftAsTemplate = async () => {
    if (!currentDraft || !user || !templateSaveName.trim()) return;
    try {
      await addDoc(collection(db, `users/${user.uid}/templates`), {
        userId: user.uid,
        name: templateSaveName.trim().slice(0, 100),
        subject: currentDraft.subject || null,
        body: currentDraft.body,
        source: 'outreach-draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      toast('Draft saved as a reusable template.', 'success');
      setTemplateSaveName('');
    } catch (err: any) {
      handleFirestoreError(err, 'create', `users/${user.uid}/templates`);
    }
  };

  const focusActivityTab = (
    tab: 'note' | 'meeting',
    fieldId: string,
  ) => {
    setActiveTab(tab);
    window.setTimeout(() => {
      document.getElementById(fieldId)?.focus();
    }, 0);
  };

  // `c` from anywhere on this record opens Draft Outreach.
  useComposeShortcut(startDrafting);

  if (!contact) return <div className="font-mono p-8">Loading...</div>;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-4 mb-2">
         <button
           type="button"
           aria-label="Back to directory"
           onClick={() => navigate('/app/directory')}
           className="p-2 hover:bg-ink/10 rounded-full transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
         >
            <ArrowLeft size={16} aria-hidden="true" />
         </button>
         <div className="min-w-0">
           <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-brand">Contact record</p>
           <h1 className="truncate font-serif text-4xl italic font-black sm:text-5xl">{contact.name}</h1>
         </div>
      </div>
      
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
         {/* Details Panel */}
         <div className="xl:col-span-1 space-y-6">
           <div className="bg-white border border-ink/15 rounded-card p-5">
             <div className="flex justify-between items-start mb-4">
               <div>
                 {contact.role && <p className="font-mono text-lg">{contact.role}</p>}
                 {/* Joined rather than interpolated with a literal bullet:
                     contacts captured from an NFC tap have no role, company
                     or location yet, and the old markup rendered a bare
                     "•" hanging under the name. */}
                 {(contact.company || contact.location) && (
                   <p className="font-mono text-subtle">
                     {[contact.company, contact.location].filter(Boolean).join(' • ')}
                   </p>
                 )}
               </div>
             </div>
             
             <div className="flex flex-col gap-2 mb-4">
                <div className="flex items-center gap-2 w-fit">
                  <TierBadge tier={contact.relationshipTier} />
                  <span className="text-xs font-mono text-subtle uppercase tracking-widest">connection</span>
                </div>
                {contact.email && <span className="text-sm font-mono text-subtle">{contact.email}</span>}
             </div>
             
             {contact.summary && (
               <div className="mb-4">
                 <h4 className="text-xs uppercase font-mono tracking-widest text-subtle mb-2">Context</h4>
                 <p className="line-clamp-4 font-mono text-sm leading-relaxed">{contact.summary}</p>
               </div>
             )}
             
             <div className="flex flex-wrap gap-2 mb-4">
                {contact.tags?.slice(0, 4).map((t: string) => (
                  <span key={t} className="px-3 py-1 bg-accent/50 border border-ink/20 font-mono text-[10px] tracking-widest uppercase">{t}</span>
                ))}
                {contact.tags?.length > 4 && (
                  <span className="px-2 py-1 font-mono text-[10px] text-subtle">+{contact.tags.length - 4}</span>
                )}
             </div>
             
             <div className="pt-4 border-t border-ink/20 flex flex-col gap-2">
               <Button ref={composeButtonRef} onClick={startDrafting} className="tour-draft-btn gap-2 w-full justify-center"><Sparkles size={16} aria-hidden="true" /> Compose Outreach</Button>
               {safeLinkedInUrl && (
                  <Button variant="outline" className="w-full justify-center" asChild>
                    <a href={safeLinkedInUrl} target="_blank" rel="noreferrer">LinkedIn Profile</a>
                  </Button>
               )}
             </div>
           </div>

         </div>

         {/* Outreach Tracker & Notes */}
         <div className="xl:col-span-2">
            <div className="bg-white border border-ink/15 rounded-card">
               <div role="tablist" aria-label="Contact activity" className="border-b border-ink/20 flex divide-x divide-ink/20 bg-paper/30 font-mono text-[10px] uppercase tracking-widest font-bold">
                 <button type="button" role="tab" id="contact-tab-note" aria-controls="contact-panel-note" aria-selected={activeTab === 'note'} onClick={() => setActiveTab('note')} className={`flex-1 py-3 hover:bg-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${activeTab === 'note' ? 'bg-white border-b-2 border-b-ink' : ''}`}>Quick Note</button>
                 <button type="button" role="tab" id="contact-tab-meeting" aria-controls="contact-panel-meeting" aria-selected={activeTab === 'meeting'} onClick={() => setActiveTab('meeting')} className={`flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${activeTab === 'meeting' ? 'bg-white border-b-2 border-b-ink' : ''}`}><Calendar size={12} aria-hidden="true"/> Log Meeting</button>
                 <button type="button" role="tab" id="contact-tab-reply" aria-controls="contact-panel-reply" aria-selected={activeTab === 'reply'} onClick={() => setActiveTab('reply')} className={`tour-reply-tab flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${activeTab === 'reply' ? 'bg-white border-b-2 border-b-ink' : ''}`}><MessageSquare size={12} aria-hidden="true"/> Log Email</button>
                 <button type="button" role="tab" id="contact-tab-parse" aria-controls="contact-panel-parse" aria-selected={activeTab === 'parse'} onClick={() => setActiveTab('parse')} className={`flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${activeTab === 'parse' ? 'bg-white border-b-2 border-b-ink' : ''}`}><Tag size={12} aria-hidden="true"/> Add AI Tags <Sparkles size={10} aria-hidden="true"/></button>
               </div>
               
               <div key={activeTab} role="tabpanel" id={`contact-panel-${activeTab}`} aria-labelledby={`contact-tab-${activeTab}`} className="p-6 border-b border-ink/20 bg-white animate-fade-in">
                 {/* Quick Note */}
                 {activeTab === 'note' && (
                   <div className="space-y-4">
                     {inlineProvenance && (
                       <AIProvenance
                         sourceIds={inlineProvenance.sourceIds}
                         sourceLabels={inlineProvenance.sourceLabels}
                         unsupportedAssumptions={inlineProvenance.unsupportedAssumptions}
                         privacyExclusions={inlineProvenance.privacyExclusions}
                         generatedAt={inlineProvenance.generatedAt}
                         sourceObservedAt={inlineProvenance.sourceObservedAt}
                         consideredSourceCount={inlineProvenance.consideredSourceCount}
                         dataFreshThrough={inlineProvenance.dataFreshThrough}
                         generation={inlineProvenance.generation}
                       />
                     )}
                     <form onSubmit={handleAddNote} className="space-y-3">
                       <div className="flex flex-col gap-2 sm:flex-row">
                         <label htmlFor="quick-note" className="sr-only">Quick note</label>
                         <Input
                           id="quick-note"
                           placeholder="Log a quick thought or action..."
                           value={newNote}
                           onChange={e => setNewNote(e.target.value)}
                           className="flex-1"
                           maxLength={20_000}
                         />
                         <Button
                           type="submit"
                           disabled={
                             isSavingNote ||
                             !newNote.trim() ||
                             (sensitiveNote &&
                               sensitiveNotePassphrase.length < 12)
                           }
                           aria-busy={isSavingNote}
                         >
                           {isSavingNote ? 'Encrypting & saving…' : 'Save'}
                         </Button>
                       </div>
                       <SensitiveNoteOption
                         enabled={sensitiveNote}
                         passphrase={sensitiveNotePassphrase}
                         onEnabledChange={(enabled) => {
                           setSensitiveNote(enabled);
                           if (!enabled) setSensitiveNotePassphrase('');
                         }}
                         onPassphraseChange={setSensitiveNotePassphrase}
                         disabled={isSavingNote}
                       />
                     </form>
                   </div>
                 )}

                 {/* Log Meeting Component */}
                 {activeTab === 'meeting' && (
                   <form onSubmit={handleLogMeeting} className="space-y-4 font-mono text-sm">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label htmlFor="meeting-date" className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Date</label>
                          <Input id="meeting-date" type="date" required value={meetingData.date} onChange={e => setMeetingData({...meetingData, date: e.target.value})} />
                        </div>
                        <div>
                          <label htmlFor="meeting-follow-up" className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Schedule Follow-up (optional)</label>
                          <Input id="meeting-follow-up" type="date" value={meetingData.followupDate} onChange={e => setMeetingData({...meetingData, followupDate: e.target.value})} />
                        </div>
                        <div className="col-span-2">
                          <label htmlFor="meeting-discussed" className="block text-[10px] uppercase tracking-widest text-subtle mb-1">What was discussed?</label>
                          <textarea id="meeting-discussed" required maxLength={20_000} className="w-full h-20 border border-ink/15 rounded-card p-3 bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" value={meetingData.discussed} onChange={e => setMeetingData({...meetingData, discussed: e.target.value})}></textarea>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label htmlFor="meeting-promised" className="block text-[10px] uppercase tracking-widest text-subtle mb-1">What was promised / Action items?</label>
                          <textarea id="meeting-promised" maxLength={20_000} className="w-full h-16 border border-ink/15 rounded-card p-3 bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" value={meetingData.promised} onChange={e => setMeetingData({...meetingData, promised: e.target.value})}></textarea>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label htmlFor="meeting-next-steps" className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Next steps</label>
                          <textarea id="meeting-next-steps" maxLength={20_000} className="w-full h-16 border border-ink/15 rounded-card p-3 bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" value={meetingData.nextSteps} onChange={e => setMeetingData({...meetingData, nextSteps: e.target.value})}></textarea>
                        </div>
                      </div>
                      <div className="flex justify-end pt-2">
                        <Button type="submit">Log Meeting Memory</Button>
                      </div>
                   </form>
                 )}

                 {/* Process Reply Component */}
                 {activeTab === 'reply' && (
                   <div className="space-y-5">
                     <form onSubmit={handleLogExternalOutreach} className="space-y-4">
                       <div>
                         <p className="font-mono text-xs font-bold text-ink">Sent it somewhere else?</p>
                         <p className="mt-1 font-mono text-xs leading-relaxed text-subtle">
                           Paste the sent email or full thread. It will count as outreach without pretending Cirqle verified delivery.
                         </p>
                       </div>
                       <div className="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
                         <div>
                           <label htmlFor="external-outreach-date" className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-subtle">
                             Sent / thread date
                           </label>
                           <Input
                             id="external-outreach-date"
                             type="date"
                             required
                             value={externalOutreach.date}
                             onChange={(event) => setExternalOutreach((current) => ({ ...current, date: event.target.value }))}
                           />
                         </div>
                         <div>
                           <label htmlFor="external-outreach-subject" className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-subtle">
                             Subject (optional)
                           </label>
                           <Input
                             id="external-outreach-subject"
                             maxLength={500}
                             value={externalOutreach.subject}
                             onChange={(event) => setExternalOutreach((current) => ({ ...current, subject: event.target.value }))}
                             placeholder="Following up"
                           />
                         </div>
                       </div>
                       <div>
                         <label htmlFor="external-outreach-thread" className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-subtle">
                           Sent email or full thread
                         </label>
                         <textarea
                           id="external-outreach-thread"
                           required
                           maxLength={70_000}
                           className="min-h-36 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                           placeholder="Paste the email or thread exactly as you have it…"
                           value={externalOutreach.thread}
                           onChange={(event) => setExternalOutreach((current) => ({ ...current, thread: event.target.value }))}
                         />
                       </div>
                       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                         <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-subtle">
                           <input
                             type="checkbox"
                             checked={externalOutreach.responseReceived}
                             onChange={(event) => setExternalOutreach((current) => ({ ...current, responseReceived: event.target.checked }))}
                           />
                           The pasted thread includes their reply
                         </label>
                         <Button
                           type="submit"
                           disabled={isSavingExternalOutreach || !externalOutreach.thread.trim()}
                           aria-busy={isSavingExternalOutreach}
                         >
                           {isSavingExternalOutreach ? 'Adding…' : 'Add to outreach'}
                         </Button>
                       </div>
                     </form>

                     <details className="border-t border-ink/10 pt-2">
                       <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                         <Sparkles size={12} aria-hidden="true" />
                         Process only a reply with AI
                       </summary>
                       <form onSubmit={handleProcessReply} className="space-y-4 pb-1 pt-4">
                      <p className="font-mono text-xs text-subtle">Choose the exact outreach this answers, or explicitly save it as unlinked. Cirqle never guesses the newest thread.</p>
                      {!contactAIAllowed && (
                        <p className="rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="status">
                          AI is disabled for this contact. The pasted reply stays local and will not be processed.
                        </p>
                      )}
                      <div>
                        <label htmlFor="reply-target" className="block text-[10px] font-bold uppercase tracking-widest text-subtle mb-1">
                          Reply belongs to
                        </label>
                        <select
                          id="reply-target"
                          required
                          value={selectedReplyTargetId}
                          onChange={(event) => setSelectedReplyTargetId(event.target.value)}
                          className="w-full border border-ink/15 rounded-card bg-paper/50 px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                        >
                          <option value="" disabled>Select an outreach or choose unlinked</option>
                          <option value="unlinked">General reply — do not change an outreach</option>
                          {outreaches.map((outreach) => (
                            <option key={outreach.id} value={outreach.id}>
                              {outreach.subject || 'No subject'} · {outreach.status || 'Drafted'}{outreach.threadId ? ' · Provider thread' : ''} · {timestampLabel(outreach.sentAt || outreach.openedAt || outreach.updatedAt)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="reply-content" className="block text-[10px] font-bold uppercase tracking-widest text-subtle mb-1">
                          Reply text
                        </label>
                        <textarea id="reply-content" required className="w-full h-32 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" placeholder="Hi there, thanks for reaching out. Let's chat next week..." value={replyText} onChange={e => setReplyText(e.target.value)}></textarea>
                      </div>
                      <div className="flex justify-end pt-2">
                        <Button type="submit" disabled={isProcessing || !contactAIAllowed || !selectedReplyTargetId || !replyText.trim()} className="gap-2" aria-busy={processingTask === 'reply'}>
                          <span aria-live="polite">{isProcessing ? 'Processing AI...' : 'Process Reply'}</span> <Sparkles size={14} aria-hidden="true"/>
                        </Button>
                      </div>
                      {processingTask === 'reply' && (
                        <AISurface
                          state="loading"
                          emptyLine=""
                          loadingStages={[
                            'Reading the pasted reply…',
                            'Checking the selected thread…',
                            'Grounding the next action…',
                          ]}
                          usageLabel="Reasoning tier"
                          onCancel={cancelAIRequest}
                        />
                      )}
                      {inlineProvenance?.feature === OUTREACH_AI_FEATURES.processReply && (
                        <AIProvenance
                          sourceIds={inlineProvenance.sourceIds}
                          sourceLabels={inlineProvenance.sourceLabels}
                          unsupportedAssumptions={inlineProvenance.unsupportedAssumptions}
                          privacyExclusions={inlineProvenance.privacyExclusions}
                          generatedAt={inlineProvenance.generatedAt}
                          sourceObservedAt={inlineProvenance.sourceObservedAt}
                          consideredSourceCount={inlineProvenance.consideredSourceCount}
                          dataFreshThrough={inlineProvenance.dataFreshThrough}
                          generation={inlineProvenance.generation}
                        />
                      )}
                       </form>
                     </details>
                   </div>
                 )}

                 {/* Parse AI Tags Component */}
                 {activeTab === 'parse' && (
                   <form onSubmit={handleParseConversation} className="space-y-4">
                      <p className="font-mono text-xs text-subtle">Paste conversation notes or a raw transcript. The AI will extract "They Mentioned" structured tags like events, hiring, or personal news and attach to their profile context.</p>
                      {!contactAIAllowed && (
                        <p className="rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="status">
                          AI is disabled for this contact. The transcript stays in this form and is not sent.
                        </p>
                      )}
                      <label htmlFor="conversation-tags-source" className="block text-[10px] font-bold uppercase tracking-widest text-subtle">Conversation or transcript</label>
                      <textarea id="conversation-tags-source" required className="w-full h-32 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" placeholder="Spoke to them. They mentioned they are moving to NY next month and will be looking for full-stack hires in Q3..." value={conversationLog} onChange={e => setConversationLog(e.target.value)}></textarea>
                      <div className="flex justify-end pt-2">
                        <Button type="submit" disabled={isProcessing || !contactAIAllowed || !conversationLog.trim()} className="gap-2" aria-busy={processingTask === 'tags'}>
                          <span aria-live="polite">{isProcessing ? 'Extracting...' : 'Extract Tags'}</span> <Sparkles size={14} aria-hidden="true"/>
                        </Button>
                      </div>
                      {processingTask === 'tags' && (
                        <AISurface
                          state="loading"
                          emptyLine=""
                          loadingStages={[
                            'Reading the transcript…',
                            'Finding exact supporting quotes…',
                            'Checking for duplicate tags…',
                          ]}
                          usageLabel="Fast tier"
                          onCancel={cancelAIRequest}
                        />
                      )}
                      {inlineProvenance?.feature === OUTREACH_AI_FEATURES.extractTags && (
                        <AIProvenance
                          sourceIds={inlineProvenance.sourceIds}
                          sourceLabels={inlineProvenance.sourceLabels}
                          unsupportedAssumptions={inlineProvenance.unsupportedAssumptions}
                          privacyExclusions={inlineProvenance.privacyExclusions}
                          generatedAt={inlineProvenance.generatedAt}
                          sourceObservedAt={inlineProvenance.sourceObservedAt}
                          consideredSourceCount={inlineProvenance.consideredSourceCount}
                          dataFreshThrough={inlineProvenance.dataFreshThrough}
                          generation={inlineProvenance.generation}
                        />
                      )}
                   </form>
                 )}
               </div>
               
               <div
                 className="bg-[#FAFAFA]"
                 role="region"
                 aria-labelledby="relationship-timeline-title"
               >
                 <div className="flex flex-col gap-3 border-b border-ink/20 bg-paper/50 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 id="relationship-timeline-title" className="font-serif text-2xl font-bold italic">
                        Relationship timeline
                      </h3>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">
                        Notes, meetings, replies, drafts, and evidenced sends in one history.
                      </p>
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-subtle sm:text-right">
                      <span className="block font-serif text-2xl font-black text-ink">
                        {relationshipTimeline.length}
                      </span>
                      event{relationshipTimeline.length === 1 ? '' : 's'}
                      {relationshipTimeline[0]?.happenedAt && (
                        <span className="mt-1 block normal-case tracking-normal">
                          Latest {timelineFreshness(relationshipTimeline[0].happenedAt).toLowerCase()}
                        </span>
                      )}
                    </div>
                 </div>
                 
                 {!notesLoaded || !outreachesLoaded ? (
                   <div role="status" className="p-8 text-center font-mono text-sm text-subtle">
                     Loading relationship history…
                   </div>
                 ) : timelineLoadError ? (
                   <div role="alert" className="m-5 border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                     {timelineLoadError}
                   </div>
                 ) : relationshipTimeline.length === 0 ? (
                   <div className="m-5 border border-dashed border-ink/20 bg-white p-8 text-center">
                     <Clock3 size={28} className="mx-auto mb-3 text-[#8C7A65]" aria-hidden="true" />
                     <h4 className="font-serif text-2xl font-bold italic">Start the relationship history.</h4>
                     <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-subtle">
                       Add the first memory, log a meeting, or prepare outreach. Cirqle will label
                       drafts, mail-client handoffs, and verified sends separately.
                     </p>
                     <div className="mt-5 flex flex-wrap justify-center gap-2">
                       <Button type="button" onClick={() => focusActivityTab('note', 'quick-note')}>
                         Add a note
                       </Button>
                       <Button
                         type="button"
                         variant="outline"
                         onClick={() => focusActivityTab('meeting', 'meeting-date')}
                       >
                         Log a meeting
                       </Button>
                       <Button type="button" variant="outline" onClick={startDrafting}>
                         Compose outreach
                       </Button>
                     </div>
                   </div>
                 ) : (
                   <div className="space-y-8 p-5 sm:p-6">
                     {relationshipTimelineGroups.map((group) => (
                       <section key={group.key} aria-labelledby={`timeline-day-${group.key}`}>
                         <div className="mb-4 flex items-center justify-between gap-3 border-b border-ink/15 pb-2">
                           <h4 id={`timeline-day-${group.key}`} className="font-serif text-xl font-bold italic">
                             {group.label}
                           </h4>
                           <span className="font-mono text-[9px] uppercase tracking-widest text-subtle">
                             {group.events.length} event{group.events.length === 1 ? '' : 's'}
                           </span>
                         </div>
                         <ol
                           className="relative space-y-4 pl-7 before:absolute before:bottom-3 before:left-[5px] before:top-3 before:w-px before:bg-[#8C7A65]/35"
                           aria-label={`${group.label} relationship events`}
                         >
                           {group.events.map((event) => (
                             <li key={event.id}>
                               <RelationshipTimelineItem
                                 event={event}
                                 onConfirmSent={confirmOutreachSent}
                                 uid={user.uid}
                               />
                             </li>
                           ))}
                         </ol>
                       </section>
                     ))}
                   </div>
                 )}

                </div>
            </div>
         </div>
      </div>

      {user && id && (
        <details className="rounded-card border border-ink/15 bg-white">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">Relationship insights</p>
              <p className="mt-0.5 text-xs text-subtle">Health, commitments, tracked threads, and the evidence chain.</p>
            </div>
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted">Open when needed</span>
          </summary>
          <div className="grid gap-5 border-t border-ink/10 p-5 lg:grid-cols-2">
            <ContactIntelligence
              uid={user.uid}
              contactId={id}
              contact={contact}
              notes={notes}
              outreaches={outreaches}
            />
            <ContactCommunicationLoop
              uid={user.uid}
              contactId={id}
              notes={notes}
              outreaches={outreaches}
            />
          </div>
        </details>
      )}

      {user && managedContact && (
        <details className="rounded-card border border-ink/15 bg-white">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">Contact data &amp; privacy</p>
              <p className="mt-0.5 text-xs text-subtle">Full profile, fact sources, job history, duplicates, introductions, and lifecycle controls.</p>
            </div>
            <span className="font-mono text-[9px] uppercase tracking-widest text-muted">Advanced</span>
          </summary>
          <div className="space-y-5 border-t border-ink/10 p-5">
            <ContactManagementWorkspace
              uid={user.uid}
              contact={managedContact}
              onFactsChanged={() => {
                void listContactFacts(user.uid, managedContact.id)
                  .then(setFacts)
                  .catch(() => setFacts([]));
              }}
              onLifecycleExit={() => navigate('/app/directory')}
            />
            <IntroductionSignalsPanel
              uid={user.uid}
              contactId={managedContact.id}
              contact={contact}
            />
          </div>
        </details>
      )}

      {/* Drafting Modal overlay */}
      {isDrafting && (
         <div
           className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/30 backdrop-blur-sm animate-fade-in"
           onClick={(e) => { if (e.target === e.currentTarget && !isDelivering) closeDrafting(); }}
         >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="outreach-dialog-title"
              aria-describedby="outreach-dialog-description"
              className="animate-fade-scale-in bg-white border border-ink/15 rounded-card w-full max-w-2xl max-h-[90vh] flex flex-col shadow-float"
            >
               <div className="p-6 border-b border-ink/20 flex justify-between items-center bg-paper/50">
                  <h2 id="outreach-dialog-title" className="font-serif text-2xl flex items-center gap-2"><Sparkles size={24} aria-hidden="true" /> Compose Outreach</h2>
                  <button
                    type="button"
                    aria-label="Close outreach composer"
                    disabled={isDelivering}
                    onClick={closeDrafting}
                    className="text-xl font-bold font-mono hover:text-red-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                  >
                    ×
                  </button>
               </div>

               <div className="p-6 overflow-y-auto flex-1 font-mono text-sm">
                  {!currentDraft ? (
                    <div className="space-y-6">
                       <p id="outreach-dialog-description" className="text-subtle mb-4">
                         Build from saved evidence or a reusable template. Cirqle will disclose the sources it uses and block unsupported attachments, history, or news before delivery.
                       </p>

                       <section className="space-y-3 border border-ink/15 bg-paper/40 p-4" aria-labelledby="template-picker-title">
                         <div>
                           <h3 id="template-picker-title" className="font-bold">Start with a template</h3>
                           <p className="mt-1 text-xs text-subtle">Optional. AI treats the selected template as a constraint, not a competing draft.</p>
                         </div>
                         <label htmlFor="outreach-template" className="block text-[10px] font-bold uppercase tracking-widest text-subtle">
                           Template
                         </label>
                         <select
                           id="outreach-template"
                           autoFocus
                           value={selectedTemplateId}
                           onChange={(event) => setSelectedTemplateId(event.target.value)}
                           className="w-full border border-ink/15 rounded-card bg-white px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                         >
                           <option value="">No template</option>
                           {templates.map((template) => (
                             <option key={template.id} value={template.id}>{template.name}</option>
                           ))}
                         </select>
                         {templates.length === 0 && (
                           <p className="text-xs text-subtle">No templates yet. You can save the finished draft as one below.</p>
                         )}
                         {templatePreview && (
                           <div className="space-y-2 border-l-2 border-ink/20 pl-3" aria-live="polite">
                             <p className="text-[10px] font-bold uppercase tracking-widest text-subtle">Variable preview</p>
                             <p className="font-bold">{templatePreview.subject || '(No subject)'}</p>
                             <p className="whitespace-pre-wrap text-xs text-ink/75">{templatePreview.body}</p>
                             {templatePreview.unresolvedVariables.length > 0 && (
                               <p className="text-xs text-amber-800">
                                 Still needs: {templatePreview.unresolvedVariables.map((variable) => `{{${variable}}}`).join(', ')}
                               </p>
                             )}
                             <Button type="button" variant="outline" size="sm" onClick={applySelectedTemplate}>
                               Use Template Without AI
                             </Button>
                           </div>
                         )}
                       </section>

                       {draftQuestions.map((q, i) => (
                          <div key={i}>
                            <label htmlFor={`draft-answer-${i}`} className="block mb-2 font-bold">{q}</label>
                            <Input
                              id={`draft-answer-${i}`}
                              value={draftAnswers[i] || ''}
                              onChange={(e) => setDraftAnswers({...draftAnswers, [i]: e.target.value})}
                              placeholder="Your answer..."
                            />
                          </div>
                         ))}
                       {!contactAIAllowed && (
                         <p className="rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="status">
                           AI is disabled for this contact. You can still choose a template and use it without AI.
                         </p>
                       )}
                       <div className="flex flex-col items-end gap-2 pt-4">
                         <Button
                           onClick={() => generateDraft('fast')}
                           disabled={isProcessing || !contactAIAllowed}
                           aria-busy={processingTask === 'draft'}
                           className="gap-2 bg-ink text-paper"
                         >
                           <span aria-live="polite">
                             {processingTask === 'draft'
                               ? 'Creating quick draft…'
                               : selectedTemplate
                                 ? 'Create Quick Draft from Template'
                                 : 'Create Quick Draft'}
                           </span>
                           <Sparkles size={16} aria-hidden="true" />
                         </Button>
                         <p className="text-[10px] text-subtle">
                           Starts with the low-cost fast tier. Improve on the premium model after review.
                         </p>
                       </div>
                       {processingTask === 'draft' && (
                         <AISurface
                           state="loading"
                           emptyLine=""
                           loadingStages={[
                             'Reviewing your instructions…',
                             'Applying source privacy…',
                             'Grounding factual claims…',
                             'Drafting the message…',
                           ]}
                           usageLabel="Fast tier"
                           onCancel={cancelAIRequest}
                         />
                       )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                       <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-ink/15 bg-paper/40 p-3">
                         <p className="text-xs text-subtle">
                           {currentDraft.quality === 'premium'
                             ? 'Premium draft · quality model'
                             : currentDraft.quality === 'quick'
                               ? 'Quick draft · fast model'
                               : 'Manual template · no AI call'}
                         </p>
                         {contactAIAllowed && (
                           <Button
                             type="button"
                             variant="outline"
                             size="sm"
                             onClick={() => generateDraft('draft')}
                             disabled={isProcessing || isDelivering}
                             aria-busy={processingTask === 'draft'}
                           >
                             <Sparkles size={13} className="mr-2" aria-hidden="true" />
                             {processingTask === 'draft'
                               ? 'Improving…'
                               : 'Improve with Premium AI'}
                           </Button>
                         )}
                       </div>
                       {processingTask === 'draft' && (
                         <AISurface
                           state="loading"
                           emptyLine=""
                           loadingStages={[
                             'Reviewing the current draft…',
                             'Rechecking source privacy…',
                             'Removing unsupported claims…',
                             'Improving tone and structure…',
                           ]}
                           usageLabel="Premium draft tier"
                           onCancel={cancelAIRequest}
                         />
                       )}
                       <div>
                         <label htmlFor="outreach-subject" className="text-[10px] uppercase tracking-widest text-subtle block mb-1">Subject</label>
                         <Input
                           id="outreach-subject"
                           value={currentDraft.subject}
                           onChange={(e) => editCurrentDraft('subject', e.target.value)}
                         />
                       </div>
                       <div>
                         <label htmlFor="outreach-body" className="text-[10px] uppercase tracking-widest text-subtle block mb-1">Body</label>
                         <textarea
                           id="outreach-body"
                           className="w-full h-64 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                           value={currentDraft.body}
                           onChange={(e) => editCurrentDraft('body', e.target.value)}
                         />
                       </div>

                       <AIProvenance
                         sourceIds={currentDraft.usedSourceIds}
                         sourceLabels={currentDraft.sourceLabels}
                         unsupportedAssumptions={currentDraft.unsupportedAssumptions}
                         privacyExclusions={currentDraft.privacyExclusions}
                         generatedAt={currentDraft.generatedAt}
                         sourceObservedAt={currentDraft.sourceObservedAt}
                         consideredSourceCount={currentDraft.consideredSourceCount}
                         dataFreshThrough={currentDraft.dataFreshThrough}
                         generation={currentDraft.generation}
                       />

                       {(currentDraft.groundingIssues.length > 0 || currentDraft.unresolvedVariables.length > 0) ? (
                         <div className="border border-red-300 bg-red-50 p-4 text-red-950" role="alert">
                           <div className="flex items-center gap-2 font-bold">
                             <AlertTriangle size={16} aria-hidden="true" />
                             Delivery blocked pending review
                           </div>
                           <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                             {currentDraft.groundingIssues.map((issue) => (
                               <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
                             ))}
                             {currentDraft.unresolvedVariables.map((variable) => (
                               <li key={variable}>Resolve template variable {`{{${variable}}}`}.</li>
                             ))}
                           </ul>
                         </div>
                       ) : (
                         <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">
                           <ShieldCheck size={16} aria-hidden="true" />
                           Grounding review passed. You still control the final wording and delivery.
                         </div>
                       )}

                       {!contact.email && (
                         <p className="border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="alert">
                           Add an email address to this contact before delivery.
                         </p>
                       )}

                       <section className="space-y-2 border border-ink/15 bg-paper/40 p-4" aria-labelledby="save-template-title">
                         <h3 id="save-template-title" className="flex items-center gap-2 font-bold"><Save size={14} aria-hidden="true" /> Save this draft as a template</h3>
                         <div className="flex flex-col gap-2 sm:flex-row">
                           <label htmlFor="draft-template-name" className="sr-only">New template name</label>
                           <Input
                             id="draft-template-name"
                             value={templateSaveName}
                             onChange={(event) => setTemplateSaveName(event.target.value)}
                             placeholder="Template name"
                           />
                           <Button
                             type="button"
                             variant="outline"
                             onClick={saveCurrentDraftAsTemplate}
                             disabled={!templateSaveName.trim() || currentDraft.groundingIssues.length > 0}
                           >
                             Save Template
                           </Button>
                         </div>
                       </section>

                       {openedOutreachId && (
                         <div className="space-y-3 border border-amber-300 bg-amber-50 p-4" role="status" aria-live="polite">
                           <p className="font-bold text-amber-950">Mail client opened — not recorded as sent.</p>
                           <p className="text-xs text-amber-900">Only confirm after you have pressed Send in your mail app.</p>
                           <div className="flex flex-wrap gap-2">
                             <Button type="button" onClick={() => confirmOutreachSent(openedOutreachId)}>
                               Yes, I Sent It
                             </Button>
                             <Button type="button" variant="outline" onClick={closeDrafting}>
                               Not Yet
                             </Button>
                           </div>
                         </div>
                       )}

                       {gmailPreview && (
                         <p className="text-right text-xs text-subtle">
                           Gmail is in preview mode. Use the mail-client handoff, then explicitly confirm only if you send it.
                         </p>
                       )}

                       <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-ink/20">
                          <Button type="button" variant="outline" onClick={() => { setCurrentDraft(null); setOpenedOutreachId(null); }} disabled={isDelivering}>Back to Context</Button>
                          <Button type="button" variant="outline" onClick={() => openMailClient()} disabled={!canDeliverDraft || isDelivering || Boolean(openedOutreachId)} className="gap-2">
                            <Send size={16} aria-hidden="true" /> Open in Mail Client
                          </Button>
                          {gmailPreview ? (
                            <PreviewBadge
                              label="Gmail preview"
                              title="Live provider delivery is not configured. Opening a mail client never counts as a verified send."
                            />
                          ) : (
                            <Button type="button" onClick={handleProviderSend} disabled={!canDeliverDraft || isDelivering || Boolean(openedOutreachId)} aria-busy={isDelivering} className="gap-2">
                              <Send size={16} aria-hidden="true" />
                              <span aria-live="polite">{isDelivering ? 'Sending...' : 'Send with Connected Gmail'}</span>
                            </Button>
                          )}
                       </div>
                    </div>
                  )}
               </div>
            </div>
         </div>
      )}
    </div>
  );
}
