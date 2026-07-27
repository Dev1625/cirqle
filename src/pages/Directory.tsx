import React, { useRef, useState, useEffect } from 'react';
import { collection, query, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, where, writeBatch, getDocs } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { TierBadge } from '../components/ui/TierBadge';
import { Plus, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { getGemini } from '../lib/gemini';
import { AI_FEATURES } from '../lib/aiDebug';
import Markdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';

import { useNavigate } from 'react-router-dom';
import { AccentRule } from '../components/ui/AccentRule';

type ImportedContact = {
  name: string;
  company: string;
  role: string;
  location: string;
  email: string;
  linkedinUrl: string;
  summary: string;
  relationshipTier: 'Cold' | 'Warm' | 'Strong';
  industry: string;
  subIndustry: string;
  tags: string[];
  school: string | null;
  seniority: string | null;
  connectionSource: string | null;
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !inQuotes) {
      row.push(cell.trim());
      if (row.some((value) => value.trim())) {
        rows.push(row);
      }

      row = [];
      cell = '';

      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      continue;
    }

    cell += character;
  }

  row.push(cell.trim());
  if (row.some((value) => value.trim())) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickValue(row: Record<string, string>, candidates: string[]) {
  for (const candidate of candidates) {
    if (row[candidate]) return row[candidate];
  }
  return '';
}

function parseTags(value: string) {
  return value
    .split(/[|,;/]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function inferTier(rawTier: string, notes: string) {
  const value = `${rawTier} ${notes}`.toLowerCase();
  if (value.includes('strong')) return 'Strong';
  if (value.includes('warm')) return 'Warm';
  return 'Cold';
}

function inferIndustry(company: string, role: string, notes: string) {
  const haystack = `${company} ${role} ${notes}`.toLowerCase();
  if (haystack.includes('bank')) return 'Investment Banking';
  if (haystack.includes('consult')) return 'Consulting';
  if (haystack.includes('private equity') || /\bpe\b/.test(haystack)) return 'Private Equity';
  if (haystack.includes('venture') || /\bvc\b/.test(haystack)) return 'Venture Capital';
  if (haystack.includes('hedge')) return 'Hedge Fund';
  if (haystack.includes('health')) return 'Healthcare';
  if (haystack.includes('tech') || haystack.includes('software') || haystack.includes('product') || haystack.includes('engineer')) return 'Tech';
  return '';
}

function normalizeTier(value?: string | null): ImportedContact['relationshipTier'] {
  const text = (value || '').toLowerCase();
  if (text.includes('strong')) return 'Strong';
  if (text.includes('warm')) return 'Warm';
  return 'Cold';
}

function toCleanString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function toCleanStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => toCleanString(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    return parseTags(value);
  }

  return [];
}

function normalizeImportedContact(value: any): ImportedContact | null {
  const name = toCleanString(value?.name);
  const company = toCleanString(value?.company);
  const role = toCleanString(value?.role);
  const email = toCleanString(value?.email);
  const summary = toCleanString(value?.summary);

  if (!name && !company && !email) return null;

  return {
    name: name || company || email,
    company,
    role,
    location: toCleanString(value?.location),
    email,
    linkedinUrl: toCleanString(value?.linkedinUrl),
    summary,
    relationshipTier: normalizeTier(value?.relationshipTier),
    industry: toCleanString(value?.industry) || inferIndustry(company, role, summary),
    subIndustry: toCleanString(value?.subIndustry),
    tags: toCleanStringArray(value?.tags),
    school: toCleanString(value?.school) || null,
    seniority: toCleanString(value?.seniority) || null,
    connectionSource: toCleanString(value?.connectionSource) || null
  };
}

function buildImportedContact(row: Record<string, string>): ImportedContact | null {
  const firstName = pickValue(row, ['first name', 'firstname']);
  const lastName = pickValue(row, ['last name', 'lastname']);
  const fullName = pickValue(row, ['name', 'full name', 'fullname']) || `${firstName} ${lastName}`.trim();
  const company = pickValue(row, ['company', 'current company']);
  const role = pickValue(row, ['position', 'title', 'role', 'headline']);
  const location = pickValue(row, ['location', 'address']);
  const email = pickValue(row, ['email', 'email address', 'emailaddress']);
  const linkedinUrl = pickValue(row, ['linkedin url', 'linkedin', 'profile url', 'profile link', 'url']);
  const summary = pickValue(row, ['summary', 'notes', 'description', 'headline']);
  const industry = pickValue(row, ['industry']);
  const subIndustry = pickValue(row, ['sub industry', 'subindustry']);
  const school = pickValue(row, ['school', 'university', 'college']);
  const seniority = pickValue(row, ['seniority']);
  const connectionSource = pickValue(row, ['connection source', 'source']);
  const rawTags = pickValue(row, ['tags', 'keywords']);
  const rawTier = pickValue(row, ['relationship tier', 'tier', 'relationship']);

  if (!fullName && !company && !email) return null;

  return {
    name: fullName || company || email,
    company,
    role,
    location,
    email,
    linkedinUrl,
    summary,
    relationshipTier: inferTier(rawTier, summary),
    industry: industry || inferIndustry(company, role, summary),
    subIndustry,
    tags: parseTags(rawTags),
    school: school || null,
    seniority: seniority || null,
    connectionSource: connectionSource || null
  };
}

async function parseContactsWithAi(rows: string[][]) {
  const headers = rows[0];
  const dataRows = rows.slice(1);
  const ai = getGemini('csvImport');
  const contacts: ImportedContact[] = [];
  const chunkSize = 25;

  for (let index = 0; index < dataRows.length; index += chunkSize) {
    const chunk = dataRows.slice(index, index + chunkSize).map((values, rowIndex) => {
      const record = headers.reduce<Record<string, string>>((result, header, headerIndex) => {
        result[header || `Column ${headerIndex + 1}`] = values[headerIndex] || '';
        return result;
      }, {});

      return {
        rowNumber: index + rowIndex + 2,
        values: record
      };
    });

    const response = await ai.models.generateContent({
      model: AI_FEATURES.csvImport.model,
      contents: `You are importing contacts into a professional CRM. Convert these CSV rows into clean contact objects even if the column names are unusual, abbreviated, or messy.

Return JSON only in this exact shape:
{
  "contacts": [
    {
      "name": "string",
      "company": "string",
      "role": "string",
      "location": "string",
      "email": "string",
      "linkedinUrl": "string",
      "summary": "string",
      "relationshipTier": "Cold | Warm | Strong",
      "industry": "string",
      "subIndustry": "string",
      "tags": ["string"],
      "school": "string",
      "seniority": "string",
      "connectionSource": "string"
    }
  ]
}

Rules:
- Infer fields from any useful column, including notes, headline, bio, tags, school, firm, title, URL, or relationship context.
- If first and last name are separate, combine them into name.
- If industry is missing, infer a concise industry from role/company/notes when possible.
- Use relationshipTier Strong only for clearly strong relationships, Warm for active or known relationships, otherwise Cold.
- Skip rows that do not look like people or useful professional contacts.
- Leave unknown fields as empty strings.

CSV rows:
${JSON.stringify(chunk)}`,
      config: {
        responseMimeType: "application/json",
      }
    });

    const parsed = JSON.parse(response.text || "{}");
    const parsedContacts = Array.isArray(parsed) ? parsed : parsed.contacts;

    if (Array.isArray(parsedContacts)) {
      parsedContacts.forEach((contact) => {
        const normalized = normalizeImportedContact(contact);
        if (normalized) contacts.push(normalized);
      });
    }
  }

  return contacts;
}

export default function Directory() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [contacts, setContacts] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  
  // Search and Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTier, setSelectedTier] = useState<string>('');
  const [selectedIndustry, setSelectedIndustry] = useState<string>('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  
  const [isAddMode, setIsAddMode] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isImportingCsv, setIsImportingCsv] = useState(false);
  const [isClearingDirectory, setIsClearingDirectory] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string>('');
  const [formData, setFormData] = useState<any>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setContacts(docs);
    }, (error) => {
       handleFirestoreError(error, 'list', `users/${user.uid}/contacts`);
    });
    return unsubscribe;
  }, [user]);

  // Derived unique lists for filters
  const uniqueIndustries = Array.from(new Set(contacts.map(c => c.industry).filter(Boolean)));
  const uniqueTiers = ['Strong', 'Warm', 'Cold'];

  // Apply Search + Filters
  const filteredContacts = contacts.filter(c => {
    const matchesSearch = c.name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          c.company?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          c.tags?.some((t: string) => t.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesTier = selectedTier ? c.relationshipTier === selectedTier : true;
    const matchesIndustry = selectedIndustry ? c.industry === selectedIndustry : true;
    
    return matchesSearch && matchesTier && matchesIndustry;
  });

  const handleParse = async () => {
    if (!pasteText.trim()) return;
    setIsParsing(true);
    try {
      const ai = getGemini('contactParse');
      const prompt = `Parse the following text into structured contact information for a professional CRM.
Text: ${pasteText}

Extract details into JSON. Use these keys exactly:
- name (string)
- company (string)
- role (string)
- location (string)
- email (string)
- linkedinUrl (string)
- summary (string, briefly explain who they are based on text)
- tags (array of strings, e.g. ["Investment Banking", "Stanford"])
- relationshipTier (string, EXACTLY one of: "Warm", "Cold", "Strong", default to "Cold")
- industry (string)
- subIndustry (string)

If a field is missing, leave it as an empty string (or empty array for tags).`;

      const response = await ai.models.generateContent({
        model: AI_FEATURES.contactParse.model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        }
      });
      
      const text = response.text || "{}";
      const parsed = JSON.parse(text);
      
      setFormData({
        ...parsed,
        relationshipTier: parsed.relationshipTier || "Cold",
        tags: parsed.tags || []
      });
    } catch (error) {
      console.error(error);
      toast("Failed to parse that text. Please try again or use manual entry.", 'error');
    } finally {
      setIsParsing(false);
    }
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !formData) return;
    
    try {
      // Normalize data so missing keys do not crash Firestore strict schema checks.
      const normalizedData = {
        name: formData.name || '',
        company: formData.company || '',
        role: formData.role || '',
        location: formData.location || '',
        email: formData.email || '',
        linkedinUrl: formData.linkedinUrl || '',
        summary: formData.summary || '',
        relationshipTier: formData.relationshipTier || 'Cold',
        industry: formData.industry || '',
        subIndustry: formData.subIndustry || '',
        tags: Array.isArray(formData.tags) ? formData.tags : [],
        lastContactedAt: null,
        seniority: null,
        school: null,
        connectionSource: null
      };

      if (formData.id) {
         await updateDoc(doc(db, `users/${user.uid}/contacts/${formData.id}`), {
           ...normalizedData,
           updatedAt: serverTimestamp()
         });
      } else {
         await addDoc(collection(db, `users/${user.uid}/contacts`), {
           ...normalizedData,
           userId: user.uid,
           createdAt: serverTimestamp(),
           updatedAt: serverTimestamp(),
         });
      }
      setIsAddMode(false);
      setFormData(null);
      setPasteText('');
    } catch (err: any) {
      handleFirestoreError(err, 'create', `users/${user.uid}/contacts`);
    }
  };

  const handleImportCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    setIsImportingCsv(true);
    setImportFeedback('');

    try {
      const csvText = await file.text();
      const rows = parseCsv(csvText);

      if (rows.length < 2) {
        throw new Error('This CSV looks empty.');
      }

      let importedContacts: ImportedContact[] = [];
      let importMode = 'AI';

      try {
        importedContacts = await parseContactsWithAi(rows);
      } catch (error) {
        console.error('AI CSV parsing failed, falling back to basic mapping.', error);
        importMode = 'basic mapping';
      }

      if (importedContacts.length === 0) {
        const headers = rows[0].map(normalizeHeader);
        importedContacts = rows
          .slice(1)
          .map((values) => {
            const rowRecord = headers.reduce<Record<string, string>>((result, header, index) => {
              result[header] = values[index] || '';
              return result;
            }, {});

            return buildImportedContact(rowRecord);
          })
          .filter(Boolean) as ImportedContact[];
      }

      if (importedContacts.length === 0) {
        throw new Error('No usable contacts were found in that file.');
      }

      const existingKeys = new Set(
        contacts.map((contact) => `${(contact.name || '').trim().toLowerCase()}|${(contact.company || '').trim().toLowerCase()}|${(contact.email || '').trim().toLowerCase()}`)
      );

      const uniqueContacts = importedContacts.filter((contact) => {
        const key = `${contact.name.trim().toLowerCase()}|${contact.company.trim().toLowerCase()}|${contact.email.trim().toLowerCase()}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });

      if (uniqueContacts.length === 0) {
        setImportFeedback('That file only contained contacts already in your directory.');
        return;
      }

      const contactCollection = collection(db, `users/${user.uid}/contacts`);
      const batchSize = 400;

      for (let index = 0; index < uniqueContacts.length; index += batchSize) {
        const batch = writeBatch(db);
        const chunk = uniqueContacts.slice(index, index + batchSize);

        chunk.forEach((contact) => {
          const contactRef = doc(contactCollection);
          batch.set(contactRef, {
            ...contact,
            userId: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            lastContactedAt: null
          });
        });

        await batch.commit();
      }

      setImportFeedback(`Imported ${uniqueContacts.length} contact${uniqueContacts.length === 1 ? '' : 's'} from ${file.name} using ${importMode}.`);
    } catch (error) {
      console.error(error);
      setImportFeedback(error instanceof Error ? error.message : 'CSV import failed. Please try another file.');
    } finally {
      event.target.value = '';
      setIsImportingCsv(false);
    }
  };

  const handleClearDirectory = async () => {
    if (!user || contacts.length === 0) {
      setImportFeedback('Directory is already empty.');
      return;
    }

    const confirmed = await confirm({
      title: 'Clear entire directory?',
      message: `This deletes ${contacts.length} contact${contacts.length === 1 ? '' : 's'} and all associated outreaches and notes. This cannot be undone.`,
      confirmLabel: 'Clear Directory',
      tone: 'danger',
    });
    if (!confirmed) return;

    setIsClearingDirectory(true);
    setImportFeedback('');

    try {
      // 1. Query all outreaches and notes under this user
      const outreachesSnap = await getDocs(collection(db, `users/${user.uid}/outreaches`));
      const notesSnap = await getDocs(collection(db, `users/${user.uid}/notes`));

      // 2. Aggregate all documents that need to be deleted
      const docsToDelete: any[] = [];

      contacts.forEach((contact) => {
        docsToDelete.push(doc(db, `users/${user.uid}/contacts/${contact.id}`));
      });

      outreachesSnap.forEach((outreachDoc) => {
        docsToDelete.push(doc(db, `users/${user.uid}/outreaches/${outreachDoc.id}`));
      });

      notesSnap.forEach((noteDoc) => {
        docsToDelete.push(doc(db, `users/${user.uid}/notes/${noteDoc.id}`));
      });

      // 3. Batch commit deletions (up to 400 docs per batch to stay under Firestore's 500 limit)
      const batchSize = 400;
      for (let index = 0; index < docsToDelete.length; index += batchSize) {
        const batch = writeBatch(db);
        docsToDelete.slice(index, index + batchSize).forEach((docRef) => {
          batch.delete(docRef);
        });
        await batch.commit();
      }

      localStorage.removeItem(`ai_brief_${user.uid}`);
      localStorage.removeItem(`ai_brief_time_${user.uid}`);
      toast(`Cleared ${contacts.length} contact${contacts.length === 1 ? '' : 's'} and all related outreach history.`, 'success');
    } catch (error) {
      handleFirestoreError(error, 'delete', `users/${user.uid}/contacts`);
    } finally {
      setIsClearingDirectory(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center pb-6 border-b border-ink/20 flex-wrap gap-4">
        <div>
           <AccentRule className="mb-4" />
           <h1 className="font-serif text-5xl italic font-black mb-2">Directory.</h1>
           <p className="font-mono text-xs uppercase tracking-widest text-muted">Filter, search, and skim through your network.</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center justify-end">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleImportCsv}
          />
          <Button onClick={() => setIsAddMode(true)} className="tour-add-contact-btn gap-2 bg-ink text-paper text-[10px] px-3 py-1 uppercase tracking-widest hover:bg-zinc-800">
            <Plus size={16} /> Add Contact
          </Button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isImportingCsv || isClearingDirectory}
            className="tour-csv-btn font-mono text-[10px] uppercase tracking-widest border border-ink/15 rounded-card px-3 py-1.5 hover:bg-ink hover:text-white transition-colors bg-white disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-2"
          >
            <Upload size={14} />
            {isImportingCsv ? 'Importing...' : 'Import CSV'}
          </button>
          <button
            type="button"
            onClick={handleClearDirectory}
            disabled={contacts.length === 0 || isImportingCsv || isClearingDirectory}
            className="font-mono text-[10px] uppercase tracking-widest border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-700 hover:text-white transition-colors bg-white disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-2"
          >
            <Trash2 size={14} />
            {isClearingDirectory ? 'Clearing...' : 'Clear Directory'}
          </button>
        </div>
      </div>

      {importFeedback && (
        <div className="border border-ink/15 bg-white px-4 py-3 font-mono text-xs uppercase tracking-widest text-subtle">
          {importFeedback}
        </div>
      )}

      {isAddMode && (
        <div className="bg-white border border-ink/25 rounded-card shadow-card p-6 mb-8 group overflow-hidden animate-fade-slide-up">
          <div className="flex justify-between items-start mb-6">
            <h2 className="font-serif text-2xl italic font-bold">New Contact</h2>
            <button onClick={() => { setIsAddMode(false); setFormData(null); setPasteText(''); }} className="text-xs font-mono uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity">Cancel</button>
          </div>
          
          {!formData ? (
            <div className="space-y-4 tour-paste-btn">
              <label className="block text-xs uppercase tracking-widest text-subtle">Paste text (LinkedIn bio, signature, notes) to auto-fill</label>
              <textarea 
                className="w-full h-32 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink"
                placeholder="John Doe is a VP at Goldman Sachs based in NY..."
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <div className="flex gap-4">
                <Button onClick={handleParse} disabled={!pasteText || isParsing} className="gap-2 bg-ink text-paper">
                  <Sparkles size={16} /> {isParsing ? 'Parsing...' : 'AI Magic Parse'}
                </Button>
                <Button variant="outline" onClick={() => setFormData({ name: '', company: '', role: '', email: '', tags: [], relationshipTier: 'Cold' })}>
                  Manual Entry
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSaveContact} className="space-y-6 font-mono text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs text-subtle block mb-1">Name *</label><Input required value={formData.name || ''} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
                <div><label className="text-xs text-subtle block mb-1">Company</label><Input value={formData.company || ''} onChange={e => setFormData({...formData, company: e.target.value})} /></div>
                <div><label className="text-xs text-subtle block mb-1">Role</label><Input value={formData.role || ''} onChange={e => setFormData({...formData, role: e.target.value})} /></div>
                <div><label className="text-xs text-subtle block mb-1">Email</label><Input value={formData.email || ''} onChange={e => setFormData({...formData, email: e.target.value})} /></div>
                <div><label className="text-xs text-subtle block mb-1">Location</label><Input value={formData.location || ''} onChange={e => setFormData({...formData, location: e.target.value})} /></div>
                <div><label className="text-xs text-subtle block mb-1">Industry</label><Input value={formData.industry || ''} onChange={e => setFormData({...formData, industry: e.target.value})} /></div>
                <div className="col-span-2"><label className="text-xs text-subtle block mb-1">Summary / Context</label><Input value={formData.summary || ''} onChange={e => setFormData({...formData, summary: e.target.value})} /></div>
                <div className="col-span-2">
                  <label className="text-xs text-subtle block mb-1">Tags (comma separated)</label>
                  <Input value={(formData.tags || []).join(', ')} onChange={e => setFormData({...formData, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean)})} />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-4 border-t border-ink/20">
                <Button type="button" variant="ghost" onClick={() => setFormData(null)}>Back</Button>
                <Button type="submit">Save Contact</Button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Directory Filters & List — this screen's primary surface, so it takes
          the stronger outer boundary + the one soft card lift. Its inner
          dividers (filter bar, contact rows) stay at /15. */}
      <div className="tour-directory-list bg-white border border-ink/25 rounded-card shadow-card">
        <div className="p-4 border-b border-ink/15 bg-paper/50 flex flex-col md:flex-row gap-4">
           {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" size={16} />
            <Input 
              className="pl-9 bg-white" 
              placeholder="Search directory..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          
           {/* Filters */}
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase">
             <select 
               className="bg-white border border-ink/15 rounded-card px-3 py-2 text-ink outline-none"
               value={selectedTier}
               onChange={(e) => setSelectedTier(e.target.value)}
             >
                <option value="">All Tiers</option>
                {uniqueTiers.map(t => <option key={t} value={t}>{t} Tier</option>)}
             </select>
             
             {uniqueIndustries.length > 0 && (
               <select 
                 className="bg-white border border-ink/15 rounded-card px-3 py-2 text-ink outline-none max-w-[120px] truncate"
                 value={selectedIndustry}
                 onChange={(e) => setSelectedIndustry(e.target.value)}
               >
                  <option value="">All Industries</option>
                  {uniqueIndustries.map(i => <option key={i} value={i}>{i}</option>)}
               </select>
             )}
          </div>
        </div>
        
        <div className="divide-y divide-ink/10">
          {filteredContacts.length === 0 ? (
            <div className="p-8 text-center text-subtle font-mono text-sm">No contacts found matching filters.</div>
          ) : (
            filteredContacts.map(c => (
              <div key={c.id} onClick={() => navigate(`/app/directory/${c.id}`)} className="tour-contact-item p-6 hover:bg-paper/30 transition-colors cursor-pointer group flex flex-col gap-4 relative">
                <div className="flex flex-col md:flex-row md:justify-between items-start md:items-center gap-4">
                   <div className="flex items-center gap-4">
                     <div className="w-10 h-10 rounded-full bg-ink flex flex-shrink-0 items-center justify-center text-paper font-serif text-lg group-hover:bg-zinc-800 transition-colors">
                       {c.name?.charAt(0)}
                     </div>
                     <div>
                       <h3 className="font-semibold text-xl group-hover:underline">{c.name}</h3>
                       <p className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                         {c.role} {c.company && `@ ${c.company}`}
                       </p>
                     </div>
                   </div>
                   
                   <div className="flex items-center gap-3">
                      {c.industry && <span className="text-[10px] uppercase tracking-widest font-mono border-b border-ink/20 pb-0.5">{c.industry}</span>}
                      <TierBadge tier={c.relationshipTier} />
                   </div>
                </div>

                {/* AI Summary Section specifically requested by user for easy skimming */}
                <div className="ml-14 font-mono text-sm leading-relaxed text-ink/80 group-hover:text-ink transition-colors line-clamp-2 pr-12">
                   {c.summary ? (
                     <div className="markdown-body prose-sm font-mono max-w-full m-0 p-0 line-clamp-2">
                       <Markdown>{c.summary}</Markdown>
                     </div>
                   ) : (
                     <span className="italic text-muted">No AI summary generated for this contact yet. Click to add context.</span>
                   )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
