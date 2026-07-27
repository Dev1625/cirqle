import React, { useState } from 'react';
import { collection, query, getDocs, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Search, Sparkles, X, Activity } from 'lucide-react';
import { generateJSON } from '../lib/ai';
import { useNavigate } from 'react-router-dom';

export function GlobalSearch() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queryStr, setQueryStr] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [explanation, setExplanation] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !queryStr.trim()) return;
    
    setIsOpen(true);
    setIsSearching(true);
    setResults([]);
    setExplanation('');

    try {
      const q = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
      const snapshot = await getDocs(q);
      const contacts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

      if (contacts.length === 0) {
        setExplanation("Network is empty. Add contacts first to search.");
        setIsSearching(false);
        return;
      }

      const miniContacts = contacts.map(c => ({
        id: c.id,
        name: c.name,
        company: c.company,
        role: c.role,
        tags: c.tags,
        summary: c.summary,
        industry: c.industry
      }));

      const prompt = `You are a professional CRM AI.
Search query: "${queryStr}"
Directory (JSON):
${JSON.stringify(miniContacts)}

1. Find the most relevant contacts for this query.
2. Short explanation (1-2 sentences) of why you chose them.
3. Return ONLY a JSON object exactly like this:
{
  "explanation": "...",
  "contactIds": ["id1", "id2"]
}`;

      const parsed = await generateJSON<{ explanation?: string; contactIds?: string[] }>(prompt, {
        tier: 'reasoning',
      });

      setExplanation(parsed.explanation || '');
      if (parsed.contactIds && Array.isArray(parsed.contactIds)) {
        const matched = parsed.contactIds.map(id => contacts.find(c => c.id === id)).filter(Boolean);
        setResults(matched);
      }
    } catch (err: any) {
      console.error(err);
      if(err.message?.includes("permission")) {
         handleFirestoreError(err, 'list', `users/${user.uid}/contacts`);
      } else {
        setExplanation("Failed to process the search. Please try again.");
      }
    } finally {
      setIsSearching(false);
    }
  };

  const closeSearch = () => {
    setIsOpen(false);
    setResults([]);
    setExplanation('');
    setQueryStr('');
  };

  return (
    <div className="w-full flex flex-col justify-end pointer-events-none">
      
      {/* Results Panel */}
      {isOpen && (
        <div className="animate-fade-slide-up bg-white border border-ink/15 rounded-card p-6 mb-4 max-h-[60vh] overflow-y-auto pointer-events-auto shadow-float">
          <div className="flex justify-between items-start mb-6">
            <h3 className="font-serif text-2xl italic font-bold flex items-center gap-2">
              <Sparkles size={20} /> AI Synthesis
            </h3>
            <button onClick={closeSearch} className="text-subtle hover:text-ink"><X size={20} /></button>
          </div>
          
          {explanation && (
            <div className="bg-accent border border-ink/15 rounded-card p-4 font-mono text-xs leading-relaxed mb-6">
              {explanation}
            </div>
          )}

          {results.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {results.map(c => (
                <div key={c.id} 
                     onClick={() => { closeSearch(); navigate(`/app/directory/${c.id}`); }}
                     className="bg-paper border border-ink/15 rounded-card p-4 flex flex-col justify-between cursor-pointer group hover:bg-ink transition-colors">
                  <div>
                    <h4 className="font-bold font-serif text-lg group-hover:text-white transition-colors">{c.name}</h4>
                    <p className="font-mono text-[10px] uppercase text-subtle mb-3 group-hover:text-white/70 transition-colors">
                      {c.role} {c.company && `@ ${c.company}`}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {c.tags?.map((t: string) => (
                      <span key={t} className="text-[9px] font-mono border border-ink/20 px-2 py-0.5 bg-white group-hover:bg-zinc-800 group-hover:text-white group-hover:border-white/20 transition-colors">{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {isSearching && (
             <div className="py-12 flex flex-col items-center justify-center text-subtle animate-pulse">
                <Activity size={32} className="mb-4" />
                <span className="font-mono text-[10px] uppercase tracking-widest">Traversing network…</span>
             </div>
          )}
        </div>
      )}

      {/* Input Bar */}
      <form onSubmit={handleSearch} className="pointer-events-auto flex items-center bg-white border border-ink/15 rounded-card relative transition-[transform,box-shadow] duration-200 focus-within:-translate-y-0.5 focus-within:border-brand/30 focus-within:shadow-float">
        <Sparkles className="absolute left-4 text-ink/40" size={18} />
        <Input
          data-shortcut="global-search"
          // placeholder:text-muted rather than placeholder:opacity-40. This is
          // the app's most prominent input and its prompt was sitting at about
          // 2.9:1 on paper — DESIGN.md §7 removed exactly this pattern
          // elsewhere for failing WCAG AA; it survived here.
          className="flex-1 py-6 pl-12 pr-24 border-0 text-sm font-mono focus-visible:ring-0 placeholder:text-muted italic font-semibold text-ink bg-transparent"
          placeholder="Ask AI: 'Who in PE can help with marketing?'   ( / )"
          value={queryStr}
          onChange={e => setQueryStr(e.target.value)}
        />
        <div className="absolute right-2 flex items-center gap-2">
          {queryStr && (
             <button type="button" onClick={() => setQueryStr('')} className="p-2 text-subtle hover:text-ink"><X size={14} /></button>
          )}
          {/* Only disabled while a search is genuinely in flight. An empty
              field is the *resting* state, not an error — disabling on it
              left the app's single most visible accent permanently dimmed
              (see the disabled treatment in Button). handleSearch already
              no-ops on an empty query. */}
          <Button type="submit" variant="brand" disabled={isSearching} size="sm" className="h-8">
            {isSearching ? '…' : 'Search'}
          </Button>
        </div>
      </form>

    </div>
  );
}
