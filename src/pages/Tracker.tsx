import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, getDocs, where, writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Link, useSearchParams } from 'react-router';
import { Filter, Search, Table, Building, Briefcase, Calendar as CalendarIcon, ListTodo, Download, Sparkles, Trash2, Clock, CheckCircle2, Send, Users, ArchiveRestore } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { getFollowUpQueueItems, getRecordDate, getRecordTime } from '../lib/tracker';
import { TierBadge } from '../components/ui/TierBadge';
import { ScrollFadeX } from '../components/ui/ScrollFadeX';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { AccentRule } from '../components/ui/AccentRule';
import { deliveryProofLabel } from '../lib/outreachWorkflow';
import {
  buildCommunicationGraph,
  summarizeCommunicationGraph,
  type CommunicationGraph,
  type CommunicationSummary,
} from '../lib/moat/communicationGraph';
import { EmptyState } from '../components/ui/EmptyState';
import { serializeCSV } from '../lib/csvExport';
import { clearDashboardBriefCache } from '../lib/dashboardBriefCache';

type ViewMode = 'sheet' | 'firm' | 'industry' | 'recruiting' | 'calendar' | 'queue';

function toCommunicationDate(value: any): string {
  const date =
    typeof value?.toDate === 'function'
      ? value.toDate()
      : value instanceof Date
        ? value
        : value
          ? new Date(value)
          : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

export default function Tracker() {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = (searchParams.get('mode') as ViewMode) || 'sheet';

  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [recentlyDeletedOutreaches, setRecentlyDeletedOutreaches] =
    useState<any[]>([]);
  const [meetingRecords, setMeetingRecords] = useState<any[]>([]);
  const [commitments, setCommitments] = useState<any[]>([]);
  const [contactsMap, setContactsMap] = useState<Record<string, any>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [outreachesLoaded, setOutreachesLoaded] = useState(false);
  const [meetingRecordsLoaded, setMeetingRecordsLoaded] = useState(false);
  const [commitmentsLoaded, setCommitmentsLoaded] = useState(false);
  const [contactsLoadError, setContactsLoadError] = useState<string | null>(null);
  const [outreachesLoadError, setOutreachesLoadError] = useState<string | null>(null);
  const [meetingRecordsLoadError, setMeetingRecordsLoadError] = useState<string | null>(null);
  const [commitmentsLoadError, setCommitmentsLoadError] = useState<string | null>(null);
  const trackerLoadError =
    contactsLoadError ||
    outreachesLoadError ||
    meetingRecordsLoadError ||
    commitmentsLoadError;
  
  const [collapsedMode, setCollapsedMode] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [isClearingTracker, setIsClearingTracker] = useState(false);
  const [isRestoringTracker, setIsRestoringTracker] = useState(false);
  
  // Filter States
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterIndustries, setFilterIndustries] = useState<string[]>([]);
  const [filterFirms, setFilterFirms] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    setContactsLoaded(false);
    setOutreachesLoaded(false);
    setMeetingRecordsLoaded(false);
    setCommitmentsLoaded(false);
    setContactsLoadError(null);
    setOutreachesLoadError(null);
    setMeetingRecordsLoadError(null);
    setCommitmentsLoadError(null);
    let isActive = true;
    
    // Fetch contacts for mapping names
    const fetchContacts = async () => {
       try {
         const q = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
         const snap = await getDocs(q);
         if (!isActive) return;
         const map: Record<string, any> = {};
         snap.docs.forEach(d => {
           map[d.id] = { id: d.id, ...d.data() };
         });
         setContactsMap(map);
         setContactsLoadError(null);
       } catch (error) {
         if (!isActive) return;
         setContactsLoadError('Cirqle could not load the contacts needed to label tracker activity. Check your connection, then refresh.');
         handleFirestoreError(error, 'list', `users/${user.uid}/contacts`);
       } finally {
         if (isActive) setContactsLoaded(true);
       }
    };
    fetchContacts();

    // Listen to outreaches
    const qO = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsub = onSnapshot(qO, (snapshot) => {
      const docs = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a: any, b: any) => getRecordTime(b) - getRecordTime(a));
      setRecentlyDeletedOutreaches(
        docs.filter(
          (outreach: any) =>
            outreach.trackerLifecycleStatus === 'deleted',
        ),
      );
      setOutreaches(
        docs.filter(
          (outreach: any) =>
            outreach.trackerLifecycleStatus !== 'deleted',
        ),
      );
      setOutreachesLoaded(true);
      setOutreachesLoadError(null);
    }, error => {
      setOutreachesLoaded(true);
      setOutreachesLoadError('Cirqle could not load your tracker activity. Check your connection, then refresh.');
      handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`);
    });

    const unsubNotes = onSnapshot(
      query(collection(db, `users/${user.uid}/notes`), where('userId', '==', user.uid)),
      (snapshot) => {
        setMeetingRecords(
          snapshot.docs
            .map((document) => ({ id: document.id, ...document.data() }))
            .filter((note: any) => note.recordType === 'meeting'),
        );
        setMeetingRecordsLoaded(true);
        setMeetingRecordsLoadError(null);
      },
      (error) => {
        setMeetingRecordsLoaded(true);
        setMeetingRecordsLoadError('Cirqle could not load meeting evidence for the tracker. Check your connection, then refresh.');
        handleFirestoreError(error, 'list', `users/${user.uid}/notes`);
      },
    );

    const unsubCommitments = onSnapshot(
      collection(db, `users/${user.uid}/commitments`),
      (snapshot) => {
        setCommitments(
          snapshot.docs.map((document) => ({
            id: document.id,
            ...document.data(),
          })),
        );
        setCommitmentsLoaded(true);
        setCommitmentsLoadError(null);
      },
      (error) => {
        setCommitmentsLoaded(true);
        setCommitmentsLoadError('Cirqle could not load commitment evidence for the tracker. Check your connection, then refresh.');
        handleFirestoreError(
          error,
          'list',
          `users/${user.uid}/commitments`,
        );
      },
    );

    return () => {
      isActive = false;
      unsub();
      unsubNotes();
      unsubCommitments();
    };
  }, [user]);

  const trackerLoaded =
    contactsLoaded &&
    outreachesLoaded &&
    meetingRecordsLoaded &&
    commitmentsLoaded;

  const communicationGraph = useMemo(
    () =>
      buildCommunicationGraph({
        outreaches: outreaches.map((outreach) => ({
          id: outreach.id,
          contactId: outreach.contactId,
          channel:
            String(outreach.channel || outreach.type).toLowerCase() === 'email'
              ? 'email'
              : 'other',
          status: outreach.status || null,
          verification: outreach.verification || null,
          createdAt: toCommunicationDate(outreach.createdAt),
          draftedAt: toCommunicationDate(outreach.draftedAt),
          openedAt: toCommunicationDate(outreach.openedAt),
          sentAt: toCommunicationDate(outreach.sentAt),
          provider: outreach.provider || null,
          threadId: outreach.threadId || null,
          providerMessageId: outreach.providerMessageId || null,
          deliveryEvidence: outreach.deliveryEvidence
            ? {
                ...outreach.deliveryEvidence,
                occurredAt: toCommunicationDate(
                  outreach.deliveryEvidence.occurredAt,
                ),
              }
            : null,
          replyEvidence: outreach.replyEvidence
            ? {
                ...outreach.replyEvidence,
                occurredAt: toCommunicationDate(
                  outreach.replyEvidence.occurredAt,
                ),
              }
            : null,
          responseReceived: outreach.responseReceived || null,
        })),
        meetings: meetingRecords.map((meeting) => ({
          id: meeting.id,
          contactId: meeting.contactId,
          occurredAt: toCommunicationDate(
            meeting.occurredAt || meeting.createdAt,
          ),
          source: meeting.providerEventId ? 'calendar' : 'user',
          outreachId: meeting.outreachId || null,
          threadId: meeting.threadId || null,
          provider: meeting.provider || null,
          providerEventId: meeting.providerEventId || null,
        })),
        commitments: commitments.map((commitment) => ({
          id: commitment.id,
          contactId: commitment.contactId,
          occurredAt: toCommunicationDate(commitment.createdAt),
          sourceRecordId: commitment.sourceId || commitment.id,
          outreachId: commitment.outreachId || null,
          meetingId: commitment.meetingId || null,
          reality: commitment.feedback?.reality || 'unreviewed',
        })),
        outcomes: commitments
          .filter((commitment) =>
            ['improved', 'unchanged', 'worsened'].includes(
              commitment.feedback?.relationshipOutcome,
            ),
          )
          .map((commitment) => ({
            id: `${commitment.id}-relationship-outcome`,
            contactId: commitment.contactId,
            occurredAt: toCommunicationDate(
              commitment.feedback?.lastEventAt ||
                commitment.feedbackUpdatedAt ||
                commitment.updatedAt,
            ),
            outcome: commitment.feedback.relationshipOutcome,
            commitmentId: commitment.id,
            meetingId: commitment.meetingId || null,
            outreachId: commitment.outreachId || null,
          })),
      }),
    [outreaches, meetingRecords, commitments],
  );
  const communicationSummary = useMemo(
    () => summarizeCommunicationGraph(communicationGraph),
    [communicationGraph],
  );

  // Derive consolidated/filtered data
  const displayData = useMemo(() => {
    let raw = outreaches.map(o => {
       const c = contactsMap[o.contactId] || {};
       return { ...o, contact: c };
    });

    if (searchQuery) {
       raw = raw.filter(o => 
         o.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
         o.contact?.company?.toLowerCase().includes(searchQuery.toLowerCase()) ||
         o.subject?.toLowerCase().includes(searchQuery.toLowerCase())
       );
    }
    
    // Apply Filters
    if (filterStatuses.length > 0) {
       raw = raw.filter(o => filterStatuses.includes(o.status || 'Drafted'));
    }
    if (filterIndustries.length > 0) {
       raw = raw.filter(o => filterIndustries.includes(o.contact?.industry));
    }
    if (filterFirms.length > 0) {
       raw = raw.filter(o => filterFirms.includes(o.contact?.company));
    }

    if (collapsedMode) {
       // Group by contactId and take the most recent
       const MapById = new Map();
       for (const r of raw) {
          if (!MapById.has(r.contactId)) {
             MapById.set(r.contactId, r);
          }
       }
       return Array.from(MapById.values());
    }

    return raw;
  }, [outreaches, contactsMap, searchQuery, collapsedMode, filterStatuses, filterIndustries, filterFirms]);
  const hasTrackerFilters = Boolean(
    searchQuery.trim() ||
      filterStatuses.length ||
      filterIndustries.length ||
      filterFirms.length,
  );
  const clearTrackerFilters = () => {
    setSearchQuery('');
    setFilterStatuses([]);
    setFilterIndustries([]);
    setFilterFirms([]);
  };
  const activeContactEntries = Object.entries(contactsMap).filter(([, contact]) => {
    const status = contact.lifecycleStatus;
    return (!status || status === 'active') && !contact.mergedIntoContactId;
  });
  const firstActiveContact = activeContactEntries[0];

  const uniqueFirms = Array.from(new Set(Object.values(contactsMap).map(c => c.company).filter(Boolean)));
  const uniqueIndustries = Array.from(new Set(Object.values(contactsMap).map(c => c.industry).filter(Boolean)));
  const allStatuses = [
    'Not Contacted',
    'Drafted',
    'Opened in Mail Client',
    'Sent (User Confirmed)',
    'Sent (Provider Verified)',
    // Legacy statuses remain filterable while old records are migrated.
    'Sent',
    'Awaiting Response',
    'Delivered',
    'Responded',
    'Pending Follow-Up',
    'Meeting Scheduled',
    'Meeting Complete',
    'Referred',
    'Closed (Positive)',
    'Closed (No Response)',
    'Re-engage',
  ];

  const handleExportCSV = () => {
     if (displayData.length === 0) return;
     const headers = ['Contact Name', 'Firm', 'Industry', 'Role', 'Status', 'Delivery Proof', 'Date', 'Type', 'Channel', 'Response Received', 'Meeting Held', 'Next Action', 'AI Summary'];
     
     const rows = displayData.map(o => [
        o.contact?.name || '',
        o.contact?.company || '',
        o.contact?.industry || '',
        o.contact?.role || '',
        o.status || '',
        deliveryProofLabel(o),
        getRecordDate(o) ? format(getRecordDate(o)!, "yyyy-MM-dd") : '',
        o.type || '',
        o.channel || '',
        o.responseReceived || '',
        o.meetingHeld ? 'Yes' : 'No',
        o.nextAction || '',
        o.aiSummary || '',
     ]);

     const csvContent = serializeCSV([headers, ...rows]);
     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
     const link = document.createElement("a");
     const url = URL.createObjectURL(blob);
     link.setAttribute("href", url);
     link.setAttribute("download", `Cirqle_Tracker_Export_${format(new Date(), "yyyyMMdd")}.csv`);
     link.style.visibility = 'hidden';
     document.body.appendChild(link);
     link.click();
     document.body.removeChild(link);
     window.setTimeout(() => URL.revokeObjectURL(url), 0);
   };

  const restoreTrackerRecords = async (recordIds?: string[]) => {
    if (!user) return;
    const ids =
      recordIds ||
      recentlyDeletedOutreaches.map((outreach) => outreach.id);
    if (ids.length === 0) return;
    setIsRestoringTracker(true);
    try {
      const batchSize = 400;
      for (let index = 0; index < ids.length; index += batchSize) {
        const batch = writeBatch(db);
        ids.slice(index, index + batchSize).forEach((id) => {
          batch.update(doc(db, `users/${user.uid}/outreaches/${id}`), {
            trackerLifecycleStatus: 'active',
            trackerDeletedAt: null,
            trackerPurgeAfter: null,
            updatedAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }
      toast(
        `Restored ${ids.length} tracker record${ids.length === 1 ? '' : 's'}.`,
        'success',
      );
    } catch (error) {
      handleFirestoreError(
        error,
        'update',
        `users/${user.uid}/outreaches`,
      );
    } finally {
      setIsRestoringTracker(false);
    }
  };

  const handleClearTracker = async () => {
     if (!user || outreaches.length === 0) return;

      const confirmed = await confirm({
         title: 'Clear tracker history?',
         message: `This moves ${outreaches.length} tracker record${outreaches.length === 1 ? '' : 's'} into recovery. Contacts and notes stay intact, and you can restore the records later.`,
         confirmLabel: 'Clear Tracker',
        tone: 'danger',
     });
     if (!confirmed) return;

     setIsClearingTracker(true);

     try {
         const batchSize = 400;
         const clearedIds = outreaches.map((outreach) => outreach.id);
         const purgeAfter = new Date(
           Date.now() + 30 * 24 * 60 * 60 * 1000,
         );

         for (let index = 0; index < outreaches.length; index += batchSize) {
            const batch = writeBatch(db);
           const chunk = outreaches.slice(index, index + batchSize);

            chunk.forEach((outreach) => {
               batch.update(
                 doc(
                   db,
                   `users/${user.uid}/outreaches/${outreach.id}`,
                 ),
                 {
                   trackerLifecycleStatus: 'deleted',
                   trackerDeletedAt: serverTimestamp(),
                   trackerPurgeAfter: purgeAfter,
                   updatedAt: serverTimestamp(),
                 },
               );
            });

           await batch.commit();
        }

        clearDashboardBriefCache(user.uid);
         toast(
           `Moved ${outreaches.length} tracker record${outreaches.length === 1 ? '' : 's'} to recovery.`,
           'success',
           8000,
           {
             label: 'Undo',
             onClick: () => restoreTrackerRecords(clearedIds),
           },
         );
     } catch (error) {
        handleFirestoreError(error, 'delete', `users/${user.uid}/outreaches`);
     } finally {
        setIsClearingTracker(false);
     }
  };

  return (
    <div className="space-y-6 flex flex-col h-full bg-paper relative">
      
      {/* Header Area */}
      <div className="flex justify-between items-end pb-6 border-b border-ink/20 flex-wrap gap-4">
        <div>
           <AccentRule className="mb-4" />
           <h1 className="font-serif text-5xl italic font-black mb-2 flex items-center gap-3">
             <Sparkles className="text-brand" size={32} />
             Tracker.
           </h1>
           <p className="font-mono text-xs uppercase tracking-widest text-muted">Global view of all relationship interactions.</p>
        </div>
         <div className="flex gap-2">
            {recentlyDeletedOutreaches.length > 0 && (
              <button
                type="button"
                onClick={() => void restoreTrackerRecords()}
                disabled={isRestoringTracker}
                aria-busy={isRestoringTracker}
                className="flex min-h-11 items-center gap-2 rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArchiveRestore size={14} aria-hidden="true" />
                {isRestoringTracker
                  ? 'Restoring…'
                  : `Restore cleared (${recentlyDeletedOutreaches.length})`}
              </button>
            )}
            <button
               type="button"
               onClick={handleClearTracker}
               disabled={isClearingTracker || !trackerLoaded || Boolean(trackerLoadError) || outreaches.length === 0}
               aria-busy={isClearingTracker}
               className="flex min-h-11 items-center gap-2 rounded-card border border-red-300 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-red-700 transition-colors hover:bg-red-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 disabled:cursor-not-allowed disabled:opacity-50"
           >
              <Trash2 size={14} aria-hidden="true" />
              {isClearingTracker ? 'Clearing…' : 'Clear Tracker'}
           </button>
           <button
             type="button"
             onClick={handleExportCSV}
             disabled={!trackerLoaded || Boolean(trackerLoadError) || displayData.length === 0}
             className="flex min-h-11 items-center gap-2 rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
           >
              <Download size={14} aria-hidden="true" /> Export CSV
           </button>
        </div>
      </div>

      {/* Control Bar (Tabs & Filters) */}
      {trackerLoadError ? (
        <div role="alert" className="border border-red-300 bg-red-50 p-4 text-sm leading-relaxed text-red-800">
          {trackerLoadError}
        </div>
      ) : !trackerLoaded ? (
        <div role="status" className="rounded-card border border-ink/25 bg-white p-6 font-mono text-sm text-subtle shadow-card">
          Loading communication evidence…
        </div>
      ) : (
        <CommunicationLoopSummary
          graph={communicationGraph}
          summary={communicationSummary}
        />
      )}

      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 bg-white border border-ink/25 rounded-card p-2 z-20 relative">
         
         {/* Tabs — wraps to a second line rather than clipping/hiding overflow at narrow widths */}
         <div className="tour-tracker-modes flex flex-wrap w-full xl:w-auto">
            {[
              { id: 'queue', label: 'Follow-Up Queue', icon: ListTodo },
              { id: 'sheet', label: 'Sheet', icon: Table },
              { id: 'recruiting', label: 'Recruiting', icon: ListTodo },
              { id: 'firm', label: 'Firm', icon: Building },
              { id: 'industry', label: 'Industry', icon: Briefcase },
              { id: 'calendar', label: 'Timeline', icon: CalendarIcon },
            ].map(t => (
               <Link
                  to={`?mode=${t.id}`}
                  key={t.id}
                  aria-current={activeView === t.id ? 'page' : undefined}
                  className={`flex min-h-11 min-w-max items-center gap-2 whitespace-nowrap border-r border-ink/10 px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${
                    activeView === t.id ? 'font-bold bg-ink text-white' : 'hover:bg-paper text-ink/70 hover:text-ink'
                  }`}
               >
                  <t.icon size={14} aria-hidden="true" /> {t.label}
               </Link>
            ))}
         </div>
         
         <div className="flex items-center gap-4 px-2 w-full xl:w-auto">
            <div className="flex items-center gap-2">
               <label htmlFor="tracker-view-mode" className="font-mono text-[10px] uppercase tracking-widest text-subtle whitespace-nowrap">View Mode:</label>
               <select
                   id="tracker-view-mode"
                  value={collapsedMode ? 'person' : 'all'}
                  onChange={e => setCollapsedMode(e.target.value === 'person')}
                  className="min-h-11 cursor-pointer rounded-card border border-ink/15 bg-transparent px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/30"
               >
                  <option value="all">Every Interaction</option>
                  <option value="person">Latest per Person</option>
               </select>
            </div>
            
             <div className="relative flex-1 xl:w-64">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle" size={14} aria-hidden="true" />
               {/* outline-none had no focus replacement, and the placeholder
                   used opacity on readable text — the exact pattern
                   DESIGN.md §7 removed for failing WCAG AA. */}
                <input
                  id="tracker-search"
                  aria-label="Search tracker"
                 value={searchQuery}
                 onChange={e => setSearchQuery(e.target.value)}
                 className="min-h-11 w-full rounded-card border border-ink/15 bg-transparent py-1 pl-8 pr-3 font-mono text-xs placeholder:text-muted focus-visible:outline-none focus-visible:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/30"
                 placeholder="Search tracker…"
               />
            </div>
             <button
                 type="button"
                 onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)}
                aria-label="Toggle advanced filters"
                aria-expanded={isFilterPanelOpen}
                aria-controls="tracker-filter-panel"
               className={`tour-filter-btn relative min-h-11 min-w-11 rounded-card border border-ink/15 p-1.5 transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${isFilterPanelOpen ? 'bg-ink text-white' : ''}`}
            >
               <Filter size={14} aria-hidden="true" />
               {(filterStatuses.length > 0 || filterFirms.length > 0 || filterIndustries.length > 0) && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-orange-500 rounded-full"></span>
               )}
            </button>
         </div>
      </div>

      {/* Filter Panel Slide-Down */}
      {isFilterPanelOpen && (
         <div id="tracker-filter-panel" className="bg-white border border-ink/15 rounded-card p-6 z-10 animate-fade-in -mt-4 relative">
            <div className="flex justify-between items-center mb-6">
               <h3 className="font-serif text-xl italic font-bold">Advanced Filters</h3>
                <button
                  type="button"
                  onClick={clearTrackerFilters}
                  disabled={!hasTrackerFilters}
                  className="min-h-11 rounded-card border border-ink/15 px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
               >
                  Clear All
               </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
               {/* Statuses */}
               <div>
                  <h4 className="font-mono text-xs uppercase tracking-widest font-bold mb-3 border-b border-ink/20 pb-1">Activity Stages</h4>
                  <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                     {allStatuses.map(s => (
                        <label key={s} className="flex items-center gap-2 cursor-pointer group">
                           <input 
                              type="checkbox" 
                              checked={filterStatuses.includes(s)}
                              onChange={(e) => {
                                 if (e.target.checked) setFilterStatuses([...filterStatuses, s]);
                                 else setFilterStatuses(filterStatuses.filter(x => x !== s));
                              }}
                              className="accent-ink w-3 h-3 cursor-pointer"
                           />
                           <StatusBadge status={s} />
                        </label>
                     ))}
                  </div>
               </div>

               {/* Industries */}
               <div>
                  <h4 className="font-mono text-xs uppercase tracking-widest font-bold mb-3 border-b border-ink/20 pb-1">Industries</h4>
                  <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                     {uniqueIndustries.map(ind => (
                        <label key={ind} className="flex items-center gap-2 cursor-pointer group">
                           <input 
                              type="checkbox" 
                              checked={filterIndustries.includes(ind)}
                              onChange={(e) => {
                                 if (e.target.checked) setFilterIndustries([...filterIndustries, ind]);
                                 else setFilterIndustries(filterIndustries.filter(x => x !== ind));
                              }}
                              className="accent-ink w-3 h-3 cursor-pointer"
                           />
                           <span className="font-mono text-[10px] uppercase tracking-widest group-hover:text-ink">{ind}</span>
                        </label>
                     ))}
                  </div>
               </div>

               {/* Firms */}
               <div>
                  <h4 className="font-mono text-xs uppercase tracking-widest font-bold mb-3 border-b border-ink/20 pb-1">Target Firms</h4>
                  <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                     {uniqueFirms.map(firm => (
                        <label key={firm} className="flex items-center gap-2 cursor-pointer group">
                           <input 
                              type="checkbox" 
                              checked={filterFirms.includes(firm)}
                              onChange={(e) => {
                                 if (e.target.checked) setFilterFirms([...filterFirms, firm]);
                                 else setFilterFirms(filterFirms.filter(x => x !== firm));
                              }}
                              className="accent-ink w-3 h-3 cursor-pointer"
                           />
                           <span className="font-mono text-[10px] uppercase tracking-widest group-hover:text-ink">{firm}</span>
                        </label>
                     ))}
                  </div>
               </div>
            </div>
         </div>
      )}

      {/* Main View Area — this screen's primary surface. In the grouped Firm/
          Industry modes it wraps a stack of nested firm cards, and with every
          boundary previously at /15 the outer container simply vanished. It
          takes the stronger boundary + card lift; the firm cards inside stay
          at /15 so the nesting reads as nesting. */}
      <div className="tour-tracker-sheet flex-1 min-h-[500px] border border-ink/25 rounded-card bg-white shadow-card overflow-hidden flex flex-col">
          {trackerLoadError ? (
            <div role="status" className="m-6 border border-dashed border-ink/20 bg-paper/40 p-10 text-center font-mono text-sm text-subtle">
              Tracker views will return after the data connection is restored.
            </div>
          ) : !trackerLoaded ? (
            <div role="status" className="p-12 text-center font-mono text-sm text-subtle">
              Loading tracker activity…
            </div>
          ) : outreaches.length === 0 ? (
            <EmptyState
              icon={activeContactEntries.length ? Send : Users}
              eyebrow="Tracker setup"
              title={activeContactEntries.length ? 'Log the first relationship interaction.' : 'Add a contact before tracking activity.'}
              description={
                activeContactEntries.length
                  ? 'Open a contact to record outreach, delivery evidence, a reply, or the next follow-up. The tracker will preserve that history across every view.'
                  : 'The tracker is an evidence-backed history of your relationships. Start the directory with one person, then record what happens next.'
              }
              primaryAction={firstActiveContact ? (
                <Link
                  to={`/app/directory/${firstActiveContact[0]}`}
                  className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Open {firstActiveContact[1].name || 'first contact'}
                </Link>
              ) : (
                <Link
                  to="/app/directory"
                  className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Add your first contact
                </Link>
              )}
              secondaryAction={firstActiveContact ? (
                <Link
                  to="/app/directory"
                  className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Browse directory
                </Link>
              ) : undefined}
              className="m-6"
            />
          ) : displayData.length === 0 ? (
            <EmptyState
              icon={Search}
              eyebrow="No matches"
              title="No tracker activity matches this view."
              description="Your interaction history is unchanged. Clear the search and advanced filters to return to all recorded activity."
              primaryAction={(
                <button
                  type="button"
                  onClick={clearTrackerFilters}
                  className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Clear search and filters
                </button>
              )}
              className="m-6"
              status
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-4 py-3">
                <p role="status" aria-live="polite" className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                  {hasTrackerFilters
                    ? `${displayData.length} of ${outreaches.length} recorded interactions`
                    : `${outreaches.length} recorded interaction${outreaches.length === 1 ? '' : 's'}`}
                  {collapsedMode ? ' · latest per person' : ''}
                </p>
                {hasTrackerFilters && (
                  <button
                    type="button"
                    onClick={clearTrackerFilters}
                    className="min-h-11 px-3 font-mono text-[10px] font-bold uppercase tracking-widest text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    Clear search and filters
                  </button>
                )}
              </div>
              {activeView === 'sheet' && <SheetView data={displayData} />}
              {activeView === 'firm' && <GroupedView data={displayData} groupBy="company" label="Firm" />}
              {activeView === 'industry' && <GroupedView data={displayData} groupBy="industry" label="Industry" />}
              {activeView === 'recruiting' && <RecruitingPipelineView data={displayData} />}
              {activeView === 'calendar' && (
                <TimelineView data={displayData} summary={communicationSummary} />
              )}
              {activeView === 'queue' && <QueueView data={displayData} />}
            </>
          )}
      </div>
    </div>
  );
}

// ----- SUB-VIEWS ------

function CommunicationLoopSummary({
  graph,
  summary,
}: {
  graph: CommunicationGraph;
  summary: CommunicationSummary;
}) {
  const sends =
    summary.stageCounts['sent-confirmed'] +
    summary.stageCounts['sent-provider'];
  const metrics = [
    { label: 'Evidenced sends', value: sends },
    {
      label: 'Provider verified',
      value: summary.stageCounts['sent-provider'],
    },
    { label: 'Linked replies', value: summary.stageCounts.replied },
    { label: 'Meetings', value: summary.stageCounts.meeting },
    { label: 'Confirmed commitments', value: summary.stageCounts.commitment },
    { label: 'Recorded outcomes', value: summary.stageCounts.outcome },
  ];

  return (
    <section
      className="rounded-card border border-ink/25 bg-white shadow-card"
      aria-labelledby="communication-loop-title"
    >
      <div className="border-b border-ink/15 bg-paper/50 px-5 py-4">
        <h2
          id="communication-loop-title"
          className="font-serif text-xl font-bold italic"
        >
          Evidence-backed communication loop
        </h2>
        <p className="mt-1 max-w-3xl font-mono text-[10px] uppercase tracking-widest text-subtle">
          Draft → send proof → reply → meeting → commitment → outcome. Workflow
          labels never count as proof on their own.
        </p>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-ink/10 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.label} className="px-4 py-4">
            <p className="font-serif text-2xl font-black">{metric.value}</p>
            <p className="mt-1 font-mono text-[9px] font-bold uppercase tracking-widest text-subtle">
              {metric.label}
            </p>
          </div>
        ))}
      </div>
      {graph.issues.length > 0 && (
        <details className="border-t border-ink/15 px-5 py-3">
          <summary className="min-h-11 cursor-pointer py-3 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
            {graph.issues.length} record
            {graph.issues.length === 1 ? ' needs' : 's need'} better linkage
            or evidence
          </summary>
          <ul className="space-y-2 pb-3 text-xs text-subtle">
            {graph.issues.slice(0, 12).map((issue) => (
              <li key={`${issue.recordType}-${issue.recordId}-${issue.code}`}>
                <span className="font-bold">{issue.recordType}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function formatRelativeDays(date: Date | null) {
   if (!date) return 'No date';
   const days = differenceInDays(new Date(), date);
   if (days === 0) return 'Today';
   if (days === 1) return '1 day ago';
   if (days > 1) return `${days} days ago`;
   if (days === -1) return 'In 1 day';
   return `In ${Math.abs(days)} days`;
}

function getPipelineStage(row: any) {
   const status = row.status || 'Drafted';
   if (status === 'Referred' || status === 'Closed (Positive)' || row.referralGenerated) return 'conversion';
   if (status === 'Meeting Scheduled' || status === 'Meeting Complete' || row.meetingHeld) return 'meeting';
   if (status === 'Responded') return 'engaged';
   if (
     status === 'Sent' ||
     status === 'Sent (User Confirmed)' ||
     status === 'Sent (Provider Verified)' ||
     status === 'Delivered' ||
     status === 'Awaiting Response' ||
     status === 'Pending Follow-Up' ||
     status === 'Re-engage'
   ) return 'contacted';
   if (status === 'Closed (No Response)') return 'closed';
   return 'prospect';
}

function RecruitingPipelineView({ data }: { data: any[] }) {
   const latestByPerson = useMemo(() => {
      const sorted = [...data].sort((a, b) => getRecordTime(b) - getRecordTime(a));
      const people = new Map<string, any>();

      sorted.forEach((row) => {
         const key = row.contactId || row.id;
         if (!people.has(key)) people.set(key, row);
      });

      return Array.from(people.values());
   }, [data]);

   const stages = [
      { id: 'prospect', label: 'Prospect', description: 'Drafted or not yet contacted' },
      { id: 'contacted', label: 'Contacted', description: 'Waiting, follow-up, or re-engage' },
      { id: 'engaged', label: 'Engaged', description: 'Response received' },
      { id: 'meeting', label: 'Meeting', description: 'Scheduled or completed' },
      { id: 'conversion', label: 'Converted', description: 'Referral or positive close' },
      { id: 'closed', label: 'Closed', description: 'No response or parked' },
   ];

   const metrics = {
      people: latestByPerson.length,
      active: latestByPerson.filter((row) => ['contacted', 'engaged', 'meeting'].includes(getPipelineStage(row))).length,
      meetings: latestByPerson.filter((row) => getPipelineStage(row) === 'meeting').length,
      converted: latestByPerson.filter((row) => getPipelineStage(row) === 'conversion').length,
      stale: latestByPerson.filter((row) => {
         const date = getRecordDate(row);
         const stage = getPipelineStage(row);
         return date && differenceInDays(new Date(), date) >= 14 && ['contacted', 'engaged'].includes(stage);
      }).length
   };

   if (latestByPerson.length === 0) {
      return <div className="p-8 text-center font-mono text-subtle">No recruiting pipeline records matched your query.</div>;
   }

   return (
      <div className="flex-1 overflow-auto bg-paper/20">
         <div className="sticky top-0 z-10 grid grid-cols-2 lg:grid-cols-5 border-b border-ink/15 bg-white">
            <PipelineMetric icon={Users} label="People" value={metrics.people} />
            <PipelineMetric icon={Send} label="Active" value={metrics.active} />
            <PipelineMetric icon={CalendarIcon} label="Meetings" value={metrics.meetings} />
            <PipelineMetric icon={CheckCircle2} label="Converted" value={metrics.converted} />
            <PipelineMetric icon={Clock} label="Stale" value={metrics.stale} />
         </div>

         <div className="flex min-w-[1180px]">
            {stages.map((stage) => {
               const items = latestByPerson
                  .filter((row) => getPipelineStage(row) === stage.id)
                  .sort((a, b) => getRecordTime(b) - getRecordTime(a));

               return (
                  <div key={stage.id} className="flex min-h-[520px] w-1/6 min-w-[260px] flex-col border-r border-ink/15 last:border-r-0">
                     <div className="border-b border-ink/15 bg-[#F8F5EF] p-4">
                        <div className="flex items-center justify-between gap-3">
                           <h3 className="font-serif text-xl font-bold italic">{stage.label}</h3>
                           <span className="border border-ink/20 bg-white px-2 py-0.5 font-mono text-[10px] font-bold">{items.length}</span>
                        </div>
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">{stage.description}</p>
                     </div>

                     <div className="flex-1 space-y-3 p-3">
                        {items.length === 0 ? (
                           <div className="border border-dashed border-ink/20 bg-white/60 p-4 text-center font-mono text-[10px] uppercase tracking-widest text-subtle">
                              Empty
                           </div>
                        ) : (
                           items.map((row) => <PipelineCard key={row.id} row={row} />)
                        )}
                     </div>
                  </div>
               );
            })}
         </div>
      </div>
   );
}

function PipelineMetric({ icon: Icon, label, value }: { icon: any, label: string, value: number }) {
   return (
      <div className="border-r border-ink/10 p-4 last:border-r-0">
         <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
            <Icon size={14} />
            {label}
         </div>
         <div className="font-serif text-3xl font-black">{value}</div>
      </div>
   );
}

function PipelineCard({ row }: { row: any }) {
   const lastTouched = getRecordDate(row);
   const stale = lastTouched && differenceInDays(new Date(), lastTouched) >= 14;

   return (
      <Link
         to={`/app/directory/${row.contactId}`}
         className={`block border bg-white p-4 transition-colors hover:bg-paper ${stale ? 'border-orange-300' : 'border-ink/20'}`}
      >
         <div className="mb-3 flex items-start justify-between gap-3">
            <div>
               <h4 className="font-serif text-lg font-bold leading-tight">{row.contact?.name || 'Unknown'}</h4>
               <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">
                  {row.contact?.role || row.type || 'Relationship'} {row.contact?.company && `@ ${row.contact.company}`}
               </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusBadge status={row.status || 'Drafted'} />
              <DeliveryProofBadge row={row} />
            </div>
         </div>

         <div className="space-y-2 border-t border-ink/10 pt-3 font-mono text-[10px] uppercase tracking-widest text-subtle">
            <div className="flex justify-between gap-3">
               <span>Last touch</span>
               <span className={stale ? 'font-bold text-orange-700' : 'text-ink/70'}>{formatRelativeDays(lastTouched)}</span>
            </div>
            <div className="flex justify-between gap-3">
               <span>Response</span>
               <span className="text-ink/70">{row.responseReceived || 'No'}</span>
            </div>
            {row.nextAction && (
               <div className="mt-3 bg-orange-50 p-2 text-orange-800 normal-case tracking-normal">
                  {row.nextAction}
               </div>
            )}
         </div>
      </Link>
   );
}

function TimelineView({
  data,
  summary,
}: {
  data: any[];
  summary: CommunicationSummary;
}) {
   const sorted = useMemo(() => [...data].sort((a, b) => getRecordTime(b) - getRecordTime(a)), [data]);
   const grouped = useMemo(() => {
      const groups = new Map<string, any[]>();

      sorted.forEach((row) => {
         const date = getRecordDate(row);
         const key = date ? format(date, 'yyyy-MM-dd') : 'undated';
         if (!groups.has(key)) groups.set(key, []);
         groups.get(key)!.push(row);
      });

      return Array.from(groups.entries());
   }, [sorted]);

   const metrics = {
      total: Object.values(summary.stageCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      replies: summary.stageCounts.replied,
      meetings: summary.stageCounts.meeting,
      actions: sorted.filter((row) => row.nextAction).length
   };

   if (sorted.length === 0) {
      return <div className="p-8 text-center font-mono text-subtle">No timeline activity matched your query.</div>;
   }

   return (
      <div className="flex-1 overflow-y-auto bg-paper/20">
         <div className="grid grid-cols-2 border-b border-ink/15 bg-white lg:grid-cols-4">
            <PipelineMetric icon={Clock} label="Events" value={metrics.total} />
            <PipelineMetric icon={Send} label="Replies" value={metrics.replies} />
            <PipelineMetric icon={CalendarIcon} label="Meetings" value={metrics.meetings} />
            <PipelineMetric icon={ListTodo} label="Actions" value={metrics.actions} />
         </div>

         <div className="mx-auto max-w-5xl p-6">
            {grouped.map(([dateKey, items]) => {
               const date = dateKey === 'undated' ? null : new Date(`${dateKey}T12:00:00`);

               return (
                  <section key={dateKey} className="mb-8 last:mb-0">
                     <div className="sticky top-0 z-10 mb-4 flex items-center justify-between border border-ink/15 rounded-card bg-white px-4 py-3">
                        <div>
                           <h3 className="font-serif text-xl font-bold italic">
                              {date ? format(date, 'EEEE, MMMM d') : 'Undated'}
                           </h3>
                           <p className="font-mono text-[10px] uppercase tracking-widest text-subtle">{items.length} event{items.length === 1 ? '' : 's'}</p>
                        </div>
                        {date && (
                           <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                              {formatRelativeDays(date)}
                           </span>
                        )}
                     </div>

                     <div className="relative space-y-3 pl-6 before:absolute before:bottom-0 before:left-[7px] before:top-0 before:w-px before:bg-ink/20">
                        {items.map((row) => <TimelineItem key={row.id} row={row} />)}
                     </div>
                  </section>
               );
            })}
         </div>
      </div>
   );
}

function TimelineItem({ row }: { row: any }) {
   const date = getRecordDate(row);
   const responded = Boolean(row.replyEvidence);
   const meeting = Boolean(row.meetingEvidence);

   return (
      <div className="relative border border-ink/15 bg-white p-4 before:absolute before:-left-[23px] before:top-5 before:h-3 before:w-3 before:rounded-full before:border before:border-ink before:bg-white">
         <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                   <StatusBadge status={row.status || 'Drafted'} />
                   <DeliveryProofBadge row={row} />
                  {responded && <span className="border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-700">Reply</span>}
                  {meeting && <span className="border border-ink/20 bg-paper px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest">Meeting</span>}
               </div>
               <Link to={`/app/directory/${row.contactId}`} className="font-serif text-xl font-bold hover:underline">
                  {row.contact?.name || 'Unknown'}
               </Link>
               <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">
                  {row.contact?.company || 'No firm'} / {row.type || 'Email'} / {row.channel || 'Email'}
               </p>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">
               {date ? format(date, 'h:mm a') : 'No time'}
            </div>
         </div>

         {(row.subject || row.aiSummary || row.nextAction) && (
            <div className="mt-4 space-y-3 border-t border-ink/10 pt-4">
               {row.subject && <p className="font-mono text-sm font-bold">{row.subject}</p>}
               {row.aiSummary && <p className="font-mono text-sm leading-relaxed text-ink/70">{row.aiSummary}</p>}
               {row.nextAction && (
                  <div className="border border-orange-200 bg-orange-50 p-3 font-mono text-xs text-orange-800">
                     {row.nextAction}
                  </div>
               )}
            </div>
         )}
      </div>
   );
}

function SheetView({ data }: { data: any[] }) {
   if (data.length === 0) return <div className="p-8 text-center font-mono text-subtle">No interaction data matched your query.</div>;

   return (
      <ScrollFadeX className="flex-1 overflow-y-auto">
         <table className="w-full text-left font-mono text-xs whitespace-nowrap">
            <thead className="bg-paper border-b border-ink/15 sticky top-0 z-10">
               <tr>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Name</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Firm</th>
                   <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Stage</th>
                   <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Delivery Proof</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Type & Channel</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Date</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Response</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Meeting</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Next Action</th>
                  <th className="p-3 font-semibold uppercase tracking-wider">AI Summary</th>
               </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
               {data.map(row => {
                  const hasAction = !!row.nextAction;
                  return (
                  <tr key={row.id} className={`hover:bg-accent/10 transition-colors group ${hasAction ? 'bg-orange-50/50' : ''}`}>
                     <td className="p-3 border-r border-ink/10">
                        <Link to={`/app/directory/${row.contactId}`} className="font-bold hover:underline">
                           {row.contact?.name || 'Unknown'}
                        </Link>
                        <TierBadge tier={row.contact?.relationshipTier} className="ml-2 !px-1.5 !py-0.5 !text-[9px]" />
                     </td>
                     <td className="p-3 border-r border-ink/10">
                        {row.contact?.company || '--'}
                     </td>
                      <td className="p-3 border-r border-ink/10 tour-tracker-status">
                         <StatusBadge status={row.status || 'Drafted'} />
                      </td>
                      <td className="p-3 border-r border-ink/10">
                         <DeliveryProofBadge row={row} />
                      </td>
                     <td className="p-3 border-r border-ink/10">
                        {row.type || 'Email'} <span className="text-subtle mx-1">•</span> {row.channel || 'Email'}
                     </td>
                     <td className="p-3 border-r border-ink/10 text-subtle">
                        {row.sentAt ? format(row.sentAt.toDate(), "MMM d, yyyy") : '--'}
                     </td>
                     <td className="p-3 border-r border-ink/10">
                        {row.responseReceived || 'No'}
                     </td>
                     <td className="p-3 border-r border-ink/10">
                         {row.meetingHeld ? 'Yes' : 'No'}
                     </td>
                     <td className={`p-3 border-r border-ink/10 max-w-[150px] truncate ${hasAction ? 'font-bold text-orange-700 bg-orange-100/50' : 'text-subtle'}`}>
                         {row.nextAction || '--'}
                     </td>
                     <td className="p-3 text-subtle italic truncate max-w-[300px]">
                         {row.aiSummary || '--'}
                     </td>
                  </tr>
               )})}
            </tbody>
         </table>
      </ScrollFadeX>
   );
}

function GroupedView({ data, groupBy, label }: { data: any[], groupBy: string, label: string }) {
   const groups = useMemo(() => {
      const g = new Map<string, any[]>();
      data.forEach(d => {
         const key = (groupBy === 'company' ? d.contact?.company : d.contact?.industry) || 'Uncategorized';
         if (!g.has(key)) g.set(key, []);
         g.get(key)!.push(d);
      });
      return Array.from(g.entries()).sort((a,b) => b[1].length - a[1].length);
   }, [data, groupBy]);

   return (
      <div className="flex-1 overflow-y-auto p-6 space-y-8 bg-paper/10">
         {groups.map(([name, items], groupIndex) => {
            const respondedCount = items.filter(i => i.responseReceived === 'Yes').length;
            const resRate = items.length ? Math.round((respondedCount / items.length) * 100) : 0;
            const meetingsCount = items.filter(i => i.meetingHeld).length;
            const meetRate = respondedCount ? Math.round((meetingsCount / respondedCount) * 100) : 0;

            return (
               <div
                  key={name}
                  style={{ animationDelay: `${Math.min(groupIndex, 8) * 45}ms` }}
                  className="animate-fade-slide-up border border-ink/15 rounded-card bg-white"
               >
                  <div className="p-4 border-b border-ink/20 flex justify-between items-center bg-paper/50 flex-wrap gap-4">
                     <h3 className="font-serif text-2xl font-bold flex items-center gap-3">
                        <Building size={20} className="text-subtle" /> {name}
                     </h3>
                     {/* Numbers that matter get the serif, same as the
                         Dashboard stat strip. These were quietly falling back
                         to small bold sans, which read as a caption rather
                         than a figure. */}
                     <div className="flex gap-6 font-mono text-xs uppercase tracking-widest text-subtle">
                        <div className="flex flex-col gap-0.5"><span className="text-[9px]">Contacts</span><span className="font-serif text-2xl font-black leading-none text-ink">{items.length}</span></div>
                        <div className="flex flex-col gap-0.5"><span className="text-[9px]">Response %</span><span className="font-serif text-2xl font-black leading-none text-ink">{resRate}%</span></div>
                        <div className="flex flex-col gap-0.5"><span className="text-[9px]">Meeting %</span><span className="font-serif text-2xl font-black leading-none text-ink">{meetRate}%</span></div>
                     </div>
                  </div>
                  <div className="p-0">
                     <SheetView data={items} />
                  </div>
               </div>
            )
         })}
      </div>
   )
}

function QueueView({ data }: { data: any[] }) {
   const queue = getFollowUpQueueItems(data);
   const now = new Date();
   const overdueCount = queue.filter((item) => item._actionDate && item._actionDate.getTime() < now.getTime()).length;
   const responseCount = queue.filter((item) => item.status === 'Responded').length;
   const reengageCount = queue.filter((item) => item.status === 'Re-engage').length;

   if (queue.length === 0) {
      return (
        <EmptyState
          icon={CheckCircle2}
          eyebrow="Queue clear"
          title="You’re caught up."
          description="The current tracker view contains activity, but none of it is overdue, waiting for a reply, or due for re-engagement."
          primaryAction={(
            <Link
              to="?mode=sheet"
              className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Review all activity
            </Link>
          )}
          secondaryAction={(
            <Link
              to="/app/directory"
              className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Open directory
            </Link>
          )}
          className="m-6"
          status
        />
      );
   }

   return (
      <div className="flex-1 overflow-y-auto bg-paper/20">
         <div className="grid grid-cols-2 border-b border-ink/15 bg-white lg:grid-cols-4">
            <PipelineMetric icon={ListTodo} label="Queue" value={queue.length} />
            <PipelineMetric icon={Clock} label="Overdue" value={overdueCount} />
            <PipelineMetric icon={Send} label="Replies" value={responseCount} />
            <PipelineMetric icon={Users} label="Re-engage" value={reengageCount} />
         </div>

         <div className="mx-auto max-w-5xl p-6">
         <h2 className="font-serif text-2xl italic font-bold mb-6 flex items-center gap-2"><ListTodo aria-hidden="true" /> Action Items</h2>
         <div className="space-y-4">
            {queue.map(q => (
               <div key={q.id} className="border border-ink/15 rounded-card bg-white p-4 hover:bg-accent/10 transition-colors flex flex-col gap-4 md:flex-row md:justify-between md:items-center group">
                  <div className="min-w-0">
                     <Link to={`/app/directory/${q.contactId}`} className="font-bold text-lg font-serif group-hover:underline">
                        {q.contact?.name || 'Unknown'} <span className="text-sm font-mono text-subtle uppercase ml-2 select-none border border-ink/15 rounded-card px-1">{q.contact?.company}</span>
                     </Link>
                      <div className="flex gap-3 text-xs font-mono mt-2 text-subtle uppercase tracking-widest">
                         <span className="text-orange-600 font-bold bg-orange-100 px-1">{q.status}</span>
                         <DeliveryProofBadge row={q} />
                        <span>{q._actionDate ? format(q._actionDate, 'MMM d') : 'No due date'}</span>
                        {q.responseReceived === 'Yes' && <span>Replied</span>}
                     </div>
                     {q.nextAction && <p className="font-mono text-sm mt-3 leading-relaxed">{q.nextAction}</p>}
                     {q.aiSummary && (
                       <div className="mt-3 rounded-card border border-ink/10 bg-paper/60 px-3 py-2">
                         <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
                           Legacy AI summary · not source evidence
                         </p>
                         <p className="mt-1 font-mono text-xs italic leading-relaxed text-muted">
                           &ldquo;{q.aiSummary}&rdquo;
                         </p>
                       </div>
                     )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                      <Link
                        to={`/app/directory/${q.contactId}`}
                        className="inline-flex min-h-11 items-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                     >
                       Open Contact
                     </Link>
                      <Link
                        to={`/app/directory/${q.contactId}`}
                        className="inline-flex min-h-11 items-center rounded-card bg-ink px-4 py-2 font-mono text-xs uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                     >
                       Take Action
                     </Link>
                  </div>
               </div>
            ))}
         </div>
         </div>
      </div>
   )
}


function StatusBadge({ status }: { status: string }) {
  const c: Record<string, string> = {
     'Not Contacted': 'bg-gray-100 text-gray-600 border-gray-300',
     'Drafted': 'bg-gray-100 text-gray-800 border-gray-400 border-dashed',
     'Opened in Mail Client': 'bg-amber-50 text-amber-800 border-amber-300',
     'Sent (User Confirmed)': 'bg-blue-50 text-blue-800 border-blue-300',
     'Sent (Provider Verified)': 'bg-emerald-50 text-emerald-800 border-emerald-300',
     'Sent': 'bg-blue-50 text-blue-700 border-blue-200',
     'Awaiting Response': 'bg-blue-100 text-blue-800 border-blue-300',
     'Delivered': 'bg-cyan-50 text-cyan-800 border-cyan-300',
     'Responded': 'bg-emerald-50 text-emerald-700 border-emerald-200',
     'Meeting Scheduled': 'bg-purple-50 text-purple-700 border-purple-200',
     'Meeting Complete': 'bg-purple-100 text-purple-800 border-purple-300',
     'Referred': 'bg-green-100 text-green-800 border-green-400 font-bold',
     'Closed (Positive)': 'bg-ink text-white border-ink',
     'Closed (No Response)': 'bg-gray-200 text-gray-500 border-gray-300 line-through',
     'Re-engage': 'bg-orange-50 text-orange-700 border-orange-200',
     'Pending Follow-Up': 'bg-orange-100 text-orange-800 border-orange-300',
  };
  const classes = c[status] || c['Drafted'];
  return (
    <span className={`px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest border ${classes} whitespace-nowrap`}>
       {status}
    </span>
  )
}

function DeliveryProofBadge({ row }: { row: any }) {
  const label = deliveryProofLabel(row);
  const verified = label === 'Provider verified';
  const userConfirmed = label === 'Confirmed by you';
  const warning =
    label === 'Not confirmed sent' ||
    label.includes('verification unknown') ||
    label === 'Preview simulation';
  const classes = verified
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : userConfirmed
      ? 'border-blue-200 bg-blue-50 text-blue-800'
      : warning
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-ink/15 bg-paper text-subtle';

  return (
    <span
      title="Delivery proof"
      className={`whitespace-nowrap border px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${classes}`}
    >
      {label}
    </span>
  );
}
