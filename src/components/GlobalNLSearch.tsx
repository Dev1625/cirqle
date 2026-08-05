import React, { useEffect, useRef, useState } from 'react';
import { collection, query, getDocs, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { AIProvenance } from './ui/AIProvenance';
import { AISurface } from './ui/AISurface';
import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { searchGroundedDirectory } from '../lib/nlSearch';
import { groundingDisplay, type GroundingDisplay } from '../lib/grounding';
import { AICancelledError } from '../lib/ai';

export function GlobalSearch() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queryStr, setQueryStr] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [explanation, setExplanation] = useState('');
  const [grounding, setGrounding] = useState<GroundingDisplay | null>(null);
  const [scopeNotice, setScopeNotice] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  const runSearch = async () => {
    if (!user || !queryStr.trim()) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsOpen(true);
    setIsSearching(true);
    setResults([]);
    setExplanation('');
    setGrounding(null);
    setScopeNotice('');
    setSearchError(null);

    try {
      const q = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
      const snapshot = await getDocs(q);
      if (controller.signal.aborted) throw new AICancelledError();
      const contacts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

      if (contacts.length === 0) {
        setExplanation("Network is empty. Add contacts first to search.");
        return;
      }

      const { grounded, sources } = await searchGroundedDirectory(
        queryStr,
        contacts,
        controller.signal,
      );
      setExplanation(grounded.result.explanation || '');
      setGrounding(groundingDisplay(grounded, sources));
      if (contacts.length > 59) {
        setScopeNotice('Searched the 59 locally most relevant records to keep private context focused.');
      }
      const matched = grounded.result.contactSourceIds
        .map((sourceId) => contacts.find((contact) => `contact-${contact.id}` === sourceId))
        .filter(Boolean);
      setResults(matched);
    } catch (err: any) {
      if (err instanceof AICancelledError || controller.signal.aborted) {
        setSearchError('Search canceled. Your question is still here.');
      } else if(err.message?.includes("permission")) {
         handleFirestoreError(err, 'list', `users/${user.uid}/contacts`);
         setSearchError('Cirqle could not read your Directory for this search.');
      } else {
        setSearchError(err?.message || 'Failed to process the search. Please try again.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch();
  };

  const closeSearch = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setIsOpen(false);
    setIsSearching(false);
    setResults([]);
    setExplanation('');
    setGrounding(null);
    setScopeNotice('');
    setSearchError(null);
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
            <button onClick={closeSearch} aria-label="Close AI search results" className="text-subtle hover:text-ink"><X size={20} /></button>
          </div>

          <AISurface
            state={isSearching ? 'loading' : searchError ? 'error' : 'ready'}
            error={searchError}
            onRetry={runSearch}
            onCancel={() => requestRef.current?.abort()}
            loadingStages={[
              'Reading eligible Directory records…',
              'Matching your question to saved facts…',
              'Checking citations and privacy exclusions…',
            ]}
            usageLabel="Reasoning AI"
            emptyLine="No matching contacts."
          >
          {explanation && (
            <div className="bg-accent border border-ink/15 rounded-card p-4 font-mono text-xs leading-relaxed mb-6">
              {explanation}
            </div>
          )}
          {scopeNotice && (
            <p className="mb-4 font-mono text-[10px] uppercase tracking-widest text-muted">
              {scopeNotice}
            </p>
          )}

          {results.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {results.map(c => (
                <button
                     type="button"
                     key={c.id}
                     onClick={() => { closeSearch(); navigate(`/app/directory/${c.id}`); }}
                     className="bg-paper border border-ink/15 rounded-card p-4 flex flex-col justify-between cursor-pointer group hover:bg-ink transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
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
                </button>
              ))}
            </div>
          )}

          {grounding && (
            <AIProvenance
              className="mt-5"
              sourceIds={grounding.usedSourceIds}
              sourceLabels={grounding.sourceLabels}
              unsupportedAssumptions={grounding.unsupportedAssumptions}
              privacyExclusions={grounding.privacyExclusions}
              generatedAt={grounding.generatedAt}
              sourceObservedAt={grounding.sourceObservedAt}
              consideredSourceCount={grounding.consideredSourceCount}
              dataFreshThrough={grounding.dataFreshThrough}
              generation={grounding.generation}
            />
          )}

          </AISurface>
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
          placeholder="Ask AI: 'Who has PE and marketing experience?'   ( / )"
          value={queryStr}
          maxLength={500}
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
