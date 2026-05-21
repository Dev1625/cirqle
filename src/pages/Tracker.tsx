import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, getDocs, where, writeBatch, doc } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Link, useSearchParams } from 'react-router-dom';
import { Filter, Search, Table, Building, Briefcase, Calendar as CalendarIcon, ListTodo, Download, Sparkles, Trash2, Clock, CheckCircle2, Send, Users } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { getFollowUpQueueItems, getRecordDate, getRecordTime } from '../lib/tracker';

type ViewMode = 'sheet' | 'firm' | 'industry' | 'recruiting' | 'calendar' | 'queue';

export default function Tracker() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = (searchParams.get('mode') as ViewMode) || 'sheet';

  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [contactsMap, setContactsMap] = useState<Record<string, any>>({});
  
  const [collapsedMode, setCollapsedMode] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [isClearingTracker, setIsClearingTracker] = useState(false);
  
  // Filter States
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterIndustries, setFilterIndustries] = useState<string[]>([]);
  const [filterFirms, setFilterFirms] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    
    // Fetch contacts for mapping names
    const fetchContacts = async () => {
       const q = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
       const snap = await getDocs(q);
       const map: Record<string, any> = {};
       snap.docs.forEach(d => {
         map[d.id] = d.data();
       });
       setContactsMap(map);
    };
    fetchContacts();

    // Listen to outreaches
    const qO = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsub = onSnapshot(qO, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setOutreaches(docs.sort((a: any, b: any) => (b.sentAt?.toMillis() || 0) - (a.sentAt?.toMillis() || 0)));
    }, error => handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`));

    return () => unsub();
  }, [user]);

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

  const uniqueFirms = Array.from(new Set(Object.values(contactsMap).map(c => c.company).filter(Boolean)));
  const uniqueIndustries = Array.from(new Set(Object.values(contactsMap).map(c => c.industry).filter(Boolean)));
  const allStatuses = ['Not Contacted', 'Drafted', 'Sent', 'Awaiting Response', 'Responded', 'Meeting Scheduled', 'Meeting Complete', 'Referred', 'Closed (Positive)', 'Closed (No Response)', 'Re-engage'];

  const handleExportCSV = () => {
     if (displayData.length === 0) return;
     const headers = ['Contact Name', 'Firm', 'Industry', 'Role', 'Status', 'Date', 'Type', 'Channel', 'Response Received', 'Meeting Held', 'Next Action', 'AI Summary'];
     
     const rows = displayData.map(o => [
        `"${o.contact?.name || ''}"`,
        `"${o.contact?.company || ''}"`,
        `"${o.contact?.industry || ''}"`,
        `"${o.contact?.role || ''}"`,
        `"${o.status || ''}"`,
        `"${o.sentAt ? format(o.sentAt.toDate(), "yyyy-MM-dd") : ''}"`,
        `"${o.type || ''}"`,
        `"${o.channel || ''}"`,
        `"${o.responseReceived || ''}"`,
        `"${o.meetingHeld ? 'Yes' : 'No'}"`,
        `"${(o.nextAction || '').replace(/"/g, '""')}"`,
        `"${(o.aiSummary || '').replace(/"/g, '""')}"`
     ]);
     
     const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
     const link = document.createElement("a");
     const url = URL.createObjectURL(blob);
     link.setAttribute("href", url);
     link.setAttribute("download", `Cirqle_Tracker_Export_${format(new Date(), "yyyyMMdd")}.csv`);
     link.style.visibility = 'hidden';
     document.body.appendChild(link);
     link.click();
     document.body.removeChild(link);
  };

  const handleClearTracker = async () => {
     if (!user || outreaches.length === 0) return;

     const confirmed = window.confirm(`Clear ${outreaches.length} tracker record${outreaches.length === 1 ? '' : 's'}? This will remove outreach history but leave contacts and notes intact.`);
     if (!confirmed) return;

     setIsClearingTracker(true);

     try {
        const batchSize = 400;

        for (let index = 0; index < outreaches.length; index += batchSize) {
           const batch = writeBatch(db);
           const chunk = outreaches.slice(index, index + batchSize);

           chunk.forEach((outreach) => {
              batch.delete(doc(db, `users/${user.uid}/outreaches/${outreach.id}`));
           });

           await batch.commit();
        }

        localStorage.removeItem(`ai_brief_${user.uid}`);
        localStorage.removeItem(`ai_brief_time_${user.uid}`);
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
           <h1 className="font-serif text-5xl italic font-black mb-2 flex items-center gap-3">
             <Sparkles className="text-ink" size={32} />
             Tracker.
           </h1>
           <p className="font-mono text-xs uppercase tracking-widest opacity-50">Global view of all relationship interactions.</p>
        </div>
        <div className="flex gap-2">
           <button
              onClick={handleClearTracker}
              disabled={isClearingTracker || outreaches.length === 0}
              className="px-4 py-2 border border-red-300 bg-white text-red-700 font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-red-700 hover:text-white transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
           >
              <Trash2 size={14} />
              {isClearingTracker ? 'Clearing...' : 'Clear Tracker'}
           </button>
           <button onClick={handleExportCSV} className="px-4 py-2 border border-ink bg-white font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-ink hover:text-white transition-colors flex items-center gap-2">
              <Download size={14} /> Export CSV
           </button>
        </div>
      </div>

      {/* Control Bar (Tabs & Filters) */}
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 bg-white border border-ink p-2 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)] z-20 relative">
         
         {/* Tabs */}
         <div className="tour-tracker-modes flex overflow-x-auto no-scrollbar w-full xl:w-auto">
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
                  className={`flex items-center gap-2 px-4 py-2 whitespace-nowrap font-mono text-xs uppercase tracking-wider transition-colors min-w-max border-r border-ink/10 last:border-0 ${
                    activeView === t.id ? 'font-bold bg-ink text-white' : 'hover:bg-paper text-ink/70 hover:text-ink'
                  }`}
               >
                  <t.icon size={14} /> {t.label}
               </Link>
            ))}
         </div>
         
         <div className="flex items-center gap-4 px-2 w-full xl:w-auto">
            <div className="flex items-center gap-2">
               <label className="font-mono text-[10px] uppercase tracking-widest text-subtle whitespace-nowrap">View Mode:</label>
               <select 
                  value={collapsedMode ? 'person' : 'all'}
                  onChange={e => setCollapsedMode(e.target.value === 'person')}
                  className="bg-transparent border border-ink font-mono text-xs px-2 py-1 outline-none focus:ring-0 focus:border-ink cursor-pointer"
               >
                  <option value="all">Every Interaction</option>
                  <option value="person">Latest per Person</option>
               </select>
            </div>
            
            <div className="relative flex-1 xl:w-64">
               <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle" size={14} />
               <input 
                 value={searchQuery}
                 onChange={e => setSearchQuery(e.target.value)}
                 className="w-full pl-8 pr-3 py-1 bg-transparent border border-ink font-mono text-xs outline-none placeholder:text-subtle/50"
                 placeholder="Search tracker..."
               />
            </div>
            <button 
               onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)}
               className={`tour-filter-btn p-1.5 border border-ink hover:bg-ink hover:text-white transition-colors relative ${isFilterPanelOpen ? 'bg-ink text-white' : ''}`}
            >
               <Filter size={14} />
               {(filterStatuses.length > 0 || filterFirms.length > 0 || filterIndustries.length > 0) && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-orange-500 rounded-full"></span>
               )}
            </button>
         </div>
      </div>

      {/* Filter Panel Slide-Down */}
      {isFilterPanelOpen && (
         <div className="bg-white border border-ink p-6 shadow-[8px_8px_0px_0px_rgba(26,26,26,1)] z-10 animate-fade-in -mt-4 relative">
            <div className="flex justify-between items-center mb-6">
               <h3 className="font-serif text-xl italic font-bold">Advanced Filters</h3>
               <button 
                  onClick={() => { setFilterStatuses([]); setFilterFirms([]); setFilterIndustries([]); }}
                  className="text-[10px] font-mono uppercase tracking-widest border border-ink px-2 py-1 hover:bg-ink hover:text-white transition-colors"
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

      {/* Main View Area */}
      <div className="tour-tracker-sheet flex-1 min-h-[500px] border border-ink bg-white shadow-[8px_8px_0px_0px_rgba(26,26,26,1)] overflow-hidden flex flex-col">
          {activeView === 'sheet' && <SheetView data={displayData} />}
          {activeView === 'firm' && <GroupedView data={displayData} groupBy="company" label="Firm" />}
          {activeView === 'industry' && <GroupedView data={displayData} groupBy="industry" label="Industry" />}
          {activeView === 'recruiting' && <RecruitingPipelineView data={displayData} />}
          {activeView === 'calendar' && <TimelineView data={displayData} />}
          {activeView === 'queue' && <QueueView data={displayData} />}
      </div>
    </div>
  );
}

// ----- SUB-VIEWS ------

function formatRelativeDays(date: Date | null) {
   if (!date) return 'No date';
   const days = differenceInDays(new Date(), date);
   if (days === 0) return 'Today';
   if (days === 1) return '1 day ago';
   return `${days} days ago`;
}

function getPipelineStage(row: any) {
   const status = row.status || 'Drafted';
   if (status === 'Referred' || status === 'Closed (Positive)' || row.referralGenerated) return 'conversion';
   if (status === 'Meeting Scheduled' || status === 'Meeting Complete' || row.meetingHeld) return 'meeting';
   if (status === 'Responded') return 'engaged';
   if (status === 'Sent' || status === 'Awaiting Response' || status === 'Pending Follow-Up' || status === 'Re-engage') return 'contacted';
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
         <div className="sticky top-0 z-10 grid grid-cols-2 lg:grid-cols-5 border-b border-ink bg-white">
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
            <StatusBadge status={row.status || 'Drafted'} />
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

function TimelineView({ data }: { data: any[] }) {
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
      total: sorted.length,
      replies: sorted.filter((row) => row.responseReceived === 'Yes' || row.status === 'Responded').length,
      meetings: sorted.filter((row) => row.meetingHeld || row.status === 'Meeting Scheduled' || row.status === 'Meeting Complete').length,
      actions: sorted.filter((row) => row.nextAction).length
   };

   if (sorted.length === 0) {
      return <div className="p-8 text-center font-mono text-subtle">No timeline activity matched your query.</div>;
   }

   return (
      <div className="flex-1 overflow-y-auto bg-paper/20">
         <div className="grid grid-cols-2 border-b border-ink bg-white lg:grid-cols-4">
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
                     <div className="sticky top-0 z-10 mb-4 flex items-center justify-between border border-ink bg-white px-4 py-3 shadow-[3px_3px_0px_0px_rgba(26,26,26,0.12)]">
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
   const responded = row.responseReceived === 'Yes' || row.status === 'Responded';
   const meeting = row.meetingHeld || row.status === 'Meeting Scheduled' || row.status === 'Meeting Complete';

   return (
      <div className="relative border border-ink/15 bg-white p-4 shadow-[3px_3px_0px_0px_rgba(26,26,26,0.08)] before:absolute before:-left-[23px] before:top-5 before:h-3 before:w-3 before:rounded-full before:border before:border-ink before:bg-white">
         <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
               <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusBadge status={row.status || 'Drafted'} />
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
      <div className="overflow-auto flex-1">
         <table className="w-full text-left font-mono text-xs whitespace-nowrap">
            <thead className="bg-paper border-b border-ink sticky top-0 z-10">
               <tr>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Name</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Firm</th>
                  <th className="p-3 font-semibold uppercase tracking-wider border-r border-ink/20">Stage</th>
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
                        {row.contact?.relationshipTier && (
                           <span className="ml-2 px-1 py-0.5 border border-ink/20 text-[9px] uppercase">{row.contact.relationshipTier}</span>
                        )}
                     </td>
                     <td className="p-3 border-r border-ink/10">
                        {row.contact?.company || '--'}
                     </td>
                     <td className="p-3 border-r border-ink/10 tour-tracker-status">
                        <StatusBadge status={row.status || 'Drafted'} />
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
      </div>
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
         {groups.map(([name, items]) => {
            const respondedCount = items.filter(i => i.responseReceived === 'Yes').length;
            const resRate = items.length ? Math.round((respondedCount / items.length) * 100) : 0;
            const meetingsCount = items.filter(i => i.meetingHeld).length;
            const meetRate = respondedCount ? Math.round((meetingsCount / respondedCount) * 100) : 0;

            return (
               <div key={name} className="border border-ink bg-white shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
                  <div className="p-4 border-b border-ink/20 flex justify-between items-center bg-paper/50 flex-wrap gap-4">
                     <h3 className="font-serif text-2xl font-bold flex items-center gap-3">
                        <Building size={20} className="text-subtle" /> {name}
                     </h3>
                     <div className="flex gap-6 font-mono text-xs uppercase tracking-widest text-subtle">
                        <div className="flex flex-col"><span className="text-[9px]">Contacts</span><span className="text-ink font-bold text-sm">{items.length}</span></div>
                        <div className="flex flex-col"><span className="text-[9px]">Response %</span><span className="text-ink font-bold text-sm">{resRate}%</span></div>
                        <div className="flex flex-col"><span className="text-[9px]">Meeting %</span><span className="text-ink font-bold text-sm">{meetRate}%</span></div>
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

   if (queue.length === 0) return <div className="p-8 text-center font-mono text-subtle">Your queue is empty! Great job.</div>;

   return (
      <div className="flex-1 overflow-y-auto bg-paper/20">
         <div className="grid grid-cols-2 border-b border-ink bg-white lg:grid-cols-4">
            <PipelineMetric icon={ListTodo} label="Queue" value={queue.length} />
            <PipelineMetric icon={Clock} label="Overdue" value={overdueCount} />
            <PipelineMetric icon={Send} label="Replies" value={responseCount} />
            <PipelineMetric icon={Users} label="Re-engage" value={reengageCount} />
         </div>

         <div className="mx-auto max-w-5xl p-6">
         <h2 className="font-serif text-2xl italic font-bold mb-6 flex items-center gap-2"><ListTodo /> Action Items</h2>
         <div className="space-y-4">
            {queue.map(q => (
               <div key={q.id} className="border border-ink bg-white p-4 hover:bg-accent/10 transition-colors flex flex-col gap-4 md:flex-row md:justify-between md:items-center group">
                  <div className="min-w-0">
                     <Link to={`/app/directory/${q.contactId}`} className="font-bold text-lg font-serif group-hover:underline">
                        {q.contact?.name || 'Unknown'} <span className="text-sm font-mono text-subtle uppercase ml-2 select-none border border-ink px-1">{q.contact?.company}</span>
                     </Link>
                     <div className="flex gap-3 text-xs font-mono mt-2 text-subtle uppercase tracking-widest">
                        <span className="text-orange-600 font-bold bg-orange-100 px-1">{q.status}</span>
                        <span>{q._actionDate ? format(q._actionDate, 'MMM d') : 'No due date'}</span>
                        {q.responseReceived === 'Yes' && <span>Replied</span>}
                     </div>
                     {q.nextAction && <p className="font-mono text-sm mt-3 leading-relaxed">{q.nextAction}</p>}
                     {q.aiSummary && <p className="font-mono text-xs italic mt-2 opacity-70">"{q.aiSummary}"</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                     <Link
                       to={`/app/directory/${q.contactId}`}
                       className="px-4 py-2 border border-ink bg-white font-mono text-xs uppercase tracking-widest hover:bg-paper transition-colors"
                     >
                       Open Contact
                     </Link>
                     <Link
                       to={`/app/directory/${q.contactId}`}
                       className="px-4 py-2 bg-ink text-white font-mono text-xs uppercase tracking-widest hover:bg-zinc-800 transition-colors"
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
     'Sent': 'bg-blue-50 text-blue-700 border-blue-200',
     'Awaiting Response': 'bg-blue-100 text-blue-800 border-blue-300',
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
