import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, getDocs, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Link } from 'react-router-dom';
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, format, isSameMonth, isSameDay, startOfDay } from 'date-fns';

export default function OutreachCalendar() {
  const { user } = useAuth();
  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [contactsMap, setContactsMap] = useState<Record<string, any>>({});
  const [currentDate, setCurrentDate] = useState(new Date());

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

    // Listen to outreaches that are pending or planned
    const qO = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsub = onSnapshot(qO, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
      // Filter for items with a future followup date
      const planned = docs.filter(o => o.nextFollowUpDate);
      setOutreaches(planned);
    }, error => handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`));

    return () => unsub();
  }, [user]);

  // Calendar rendering logic
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const dateFormat = "d";
  const rows = [];
  let days = [];
  let day = startDate;
  let formattedDate = "";

  while (day <= endDate) {
    for (let i = 0; i < 7; i++) {
       formattedDate = format(day, dateFormat);
       const cloneDay = day;
       
       // Find outreaches for this day
       const dayOutreaches = outreaches.filter(o => {
          if (!o.nextFollowUpDate) return false;
          return isSameDay(o.nextFollowUpDate.toDate(), cloneDay);
       });

       days.push(
         <div 
            key={day.toString()} 
            className={`min-h-[120px] p-2 border-r border-b border-ink/20 flex flex-col ${!isSameMonth(day, monthStart) ? 'bg-black/5 text-subtle' : 'bg-white'}`}
          >
            <span className={`font-mono text-xs mb-2 ${isSameDay(day, new Date()) ? 'bg-ink text-white w-6 h-6 flex items-center justify-center rounded-full' : ''}`}>
                {formattedDate}
            </span>
            <div className="flex-1 space-y-1 overflow-y-auto">
               {dayOutreaches.map(o => {
                  const contact = contactsMap[o.contactId];
                  return (
                     <Link 
                        key={o.id} 
                        to={`/app/directory/${o.contactId}`}
                        className={`block text-[10px] uppercase font-mono px-2 py-1 truncate border transition-colors ${o.status === 'Pending Follow-Up' ? 'bg-accent/50 border-ink/40 hover:bg-accent' : 'bg-paper border-ink/20 hover:bg-paper/80'}`}
                     >
                        {contact ? contact.name : 'Unknown'}
                     </Link>
                  )
               })}
            </div>
         </div>
       );
       day = addDays(day, 1);
    }
    rows.push(
       <div key={day.toString()} className="grid grid-cols-7">
          {days}
       </div>
    );
    days = [];
  }

  const nextMonth = () => setCurrentDate(addDays(monthEnd, 1));
  const prevMonth = () => setCurrentDate(addDays(monthStart, -1));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center pb-6 border-b border-ink/20 flex-wrap gap-4">
         <div>
            <h1 className="font-serif text-5xl italic font-black mb-2">Outreach Calendar.</h1>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Pace yourself. View upcoming planned follow-ups.</p>
         </div>
         <div className="flex gap-2">
            <button onClick={prevMonth} className="px-4 py-2 border border-ink bg-white font-mono text-xs hover:bg-paper uppercase tracking-widest">Prev</button>
            <div className="px-6 py-2 border border-ink bg-white font-serif font-bold text-lg flex items-center justify-center min-w-[200px]">
               {format(currentDate, "MMMM yyyy")}
            </div>
            <button onClick={nextMonth} className="px-4 py-2 border border-ink bg-white font-mono text-xs hover:bg-paper uppercase tracking-widest">Next</button>
         </div>
      </div>

      <div className="bg-white border-l border-t border-ink/20 border-r border-b-0 shadow-[8px_8px_0px_0px_rgba(26,26,26,1)]">
         <div className="grid grid-cols-7 bg-paper/50 border-b border-ink/20">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
               <div key={d} className="p-3 font-mono text-[10px] uppercase tracking-widest text-center border-r border-ink/20 font-bold">{d}</div>
            ))}
         </div>
         <div className="flex flex-col border-b border-ink/20">
            {rows}
         </div>
      </div>
    </div>
  );
}
