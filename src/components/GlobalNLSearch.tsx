import React, { useState } from 'react';
import { collection, query, getDocs, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Search, Sparkles, X, Activity } from 'lucide-react';
import { getGemini } from '../lib/gemini';
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

      const ai = getGemini();
      
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

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      const parsed = JSON.parse(response.text || "{}");
      
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
        <div className="bg-white border border-ink p-6 mb-4 max-h-[60vh] overflow-y-auto pointer-events-auto transform transition-all shadow-[8px_8px_0px_0px_rgba(26,26,26,1)]">
          <div className="flex justify-between items-start mb-6">
            <h3 className="font-serif text-2xl italic font-bold flex items-center gap-2">
              <Sparkles size={20} /> AI Synthesis
            </h3>
            <button onClick={closeSearch} className="text-subtle hover:text-ink"><X size={20} /></button>
          </div>
          
          {explanation && (
            <div className="bg-accent border border-ink p-4 font-mono text-xs leading-relaxed mb-6">
              {explanation}
            </div>
          )}

          {results.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {results.map(c => (
                <div key={c.id} 
                     onClick={() => { closeSearch(); navigate(`/app/directory/${c.id}`); }}
                     className="bg-paper border border-ink p-4 flex flex-col justify-between cursor-pointer group hover:bg-ink transition-colors">
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
                <span className="font-mono text-[10px] uppercase tracking-widest">Traversing Network...</span>
             </div>
          )}
        </div>
      )}

      {/* Input Bar */}
      <form onSubmit={handleSearch} className="pointer-events-auto flex items-center bg-white border border-ink relative shadow-[8px_8px_0px_0px_rgba(26,26,26,1)] transition-transform focus-within:-translate-y-1 focus-within:-translate-x-1 focus-within:shadow-[12px_12px_0px_0px_rgba(26,26,26,1)]">
        <Sparkles className="absolute left-4 text-ink/40" size={18} />
        <Input 
          className="flex-1 py-6 pl-12 pr-24 border-0 text-sm font-mono focus-visible:ring-0 placeholder:opacity-40 italic font-semibold text-ink bg-transparent"
          placeholder="Ask AI: 'Who in PE can help with marketing?'"
          value={queryStr}
          onChange={e => setQueryStr(e.target.value)}
        />
        <div className="absolute right-2 flex items-center gap-2">
          {queryStr && (
             <button type="button" onClick={() => setQueryStr('')} className="p-2 text-subtle hover:text-ink"><X size={14} /></button>
          )}
          <Button type="submit" disabled={isSearching || !queryStr} size="sm" className="bg-ink text-paper h-8 rounded-none">
            {isSearching ? '...' : 'Search'}
          </Button>
        </div>
      </form>

    </div>
  );
}
