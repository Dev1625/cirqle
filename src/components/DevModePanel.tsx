import React, { useState } from 'react';
import { Terminal, Trash2, ChevronDown, ChevronRight, CircleCheck, CircleX } from 'lucide-react';
import {
  AI_FEATURES,
  clearAiCalls,
  useAiCalls,
  useDevMode,
  type AiCall,
  type AiFeatureKey,
} from '../lib/aiDebug';
import { getApiKeySource, getGatewayUrl } from '../lib/gemini';

/**
 * Dev Mode — an inspector for everything the AI layer is doing.
 *
 * Two halves, and both matter. The registry answers "what model is this
 * feature *supposed* to run on" without reading source; the call log answers
 * "what did it actually just do" — model, endpoint, latency, token usage and
 * the prompt that went out. The log is populated by the wrapper in
 * lib/aiDebug regardless of whether Dev Mode is on, so switching it on after
 * using a feature still shows that call rather than an empty list.
 */
export function DevModePanel() {
  const [devMode, setDevMode] = useDevMode();
  const calls = useAiCalls();

  return (
    <div className="bg-white border border-ink/15 rounded-card p-8 max-w-4xl">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h3 className="font-serif text-2xl flex items-center gap-2">
            <Terminal size={20} className="text-brand" /> Dev Mode
          </h3>
          <p className="mt-2 font-mono text-sm text-subtle max-w-[60ch]">
            Shows which model, endpoint and prompt each AI feature uses, and logs every
            call as you make it. Nothing here changes behaviour — it only reveals it.
          </p>
        </div>
        <Toggle checked={devMode} onChange={setDevMode} label="Dev Mode" />
      </div>

      {devMode && (
        <div className="mt-8 space-y-8 animate-fade-slide-up">
          <Environment />
          <Registry />
          <CallLog calls={calls} />
        </div>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`flex shrink-0 items-center gap-3 rounded-card border px-3 py-2 font-mono text-[10px] uppercase tracking-widest font-bold transition-colors ${
        checked ? 'border-ink bg-ink text-paper' : 'border-ink/15 text-subtle hover:border-ink'
      }`}
    >
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${
          checked ? 'bg-brand' : 'bg-ink/20'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            checked ? 'left-3.5' : 'left-0.5'
          }`}
        />
      </span>
      {checked ? 'On' : 'Off'}
    </button>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-ink/15 pb-2 mb-4">
        <h4 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function Environment() {
  const rows: [string, string][] = [
    ['Gateway', getGatewayUrl()],
    ['API key', getApiKeySource()],
    ['Firestore', import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' ? 'local emulator' : 'live project'],
    ['Vite mode', import.meta.env.MODE],
  ];

  return (
    <Section title="Environment">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 border-b border-ink/10 pb-2">
            <dt className="text-muted uppercase tracking-widest text-[10px]">{k}</dt>
            <dd className="truncate text-right" title={v}>{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Registry() {
  const entries = Object.entries(AI_FEATURES) as [AiFeatureKey, (typeof AI_FEATURES)[AiFeatureKey]][];

  return (
    <Section title={`AI features · ${entries.length}`}>
      <div className="divide-y divide-ink/10">
        {entries.map(([key, feature]) => (
          <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
            <div className="min-w-0">
              <p className="font-mono text-xs font-bold">{feature.label}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted mt-1">
                {feature.surface}
              </p>
              <p className="font-mono text-[11px] text-subtle mt-1.5">{feature.purpose}</p>
            </div>
            <code className="shrink-0 rounded-card bg-accent/60 px-2 py-1 font-mono text-[10px]">
              {feature.model}
            </code>
          </div>
        ))}
      </div>
    </Section>
  );
}

function CallLog({ calls }: { calls: AiCall[] }) {
  return (
    <Section
      title={`Call log · ${calls.length}`}
      action={
        calls.length > 0 ? (
          <button
            type="button"
            onClick={clearAiCalls}
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted hover:text-ink transition-colors"
          >
            <Trash2 size={12} /> Clear
          </button>
        ) : undefined
      }
    >
      {calls.length === 0 ? (
        <p className="border border-dashed border-ink/20 bg-paper/40 p-8 text-center font-mono text-xs text-subtle">
          No AI calls yet this session. Use any AI feature and it will appear here.
        </p>
      ) : (
        <div className="space-y-2">
          {calls.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </div>
      )}
    </Section>
  );
}

function CallRow({ call }: { call: AiCall }) {
  const [open, setOpen] = useState(false);
  const feature = AI_FEATURES[call.feature];

  return (
    <div className="border border-ink/15 rounded-card bg-paper/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper transition-colors"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />}
        {call.status === 'ok' ? (
          <CircleCheck size={13} className="shrink-0 text-emerald-600" />
        ) : (
          <CircleX size={13} className="shrink-0 text-brand" />
        )}
        <span className="font-mono text-xs font-bold">{feature?.label ?? call.feature}</span>
        <code className="rounded-card bg-accent/60 px-1.5 py-0.5 font-mono text-[10px]">{call.model}</code>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted ml-auto">
          {call.durationMs}ms · {new Date(call.startedAt).toLocaleTimeString()}
        </span>
      </button>

      {open && (
        <div className="border-t border-ink/10 px-4 py-3 space-y-2.5 font-mono text-[11px]">
          <Field label="Endpoint" value={call.endpoint} />
          {/* The registry says one thing and the SDK was handed another — worth
              seeing side by side, since that is exactly the drift Dev Mode is
              here to catch. */}
          {feature && feature.model !== call.model && (
            <p className="rounded-card border border-brand/40 bg-brand/5 px-3 py-2 text-brand">
              Registry expects <strong>{feature.model}</strong> for this feature.
            </p>
          )}
          <Field label="Prompt" value={`${call.promptChars.toLocaleString()} chars`} />
          {call.responseChars !== undefined && (
            <Field label="Response" value={`${call.responseChars.toLocaleString()} chars`} />
          )}
          {call.tokens && (
            <Field
              label="Tokens"
              value={`in ${call.tokens.prompt ?? '—'} · out ${call.tokens.response ?? '—'} · total ${call.tokens.total ?? '—'}`}
            />
          )}
          {call.error && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Error</p>
              <pre className="whitespace-pre-wrap break-words rounded-card border border-ink/15 bg-white p-3 text-brand">
                {call.error}
              </pre>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Prompt preview</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-card border border-ink/15 bg-white p-3 text-subtle">
              {call.promptPreview}
              {call.promptChars > call.promptPreview.length ? '\n…' : ''}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[10px] uppercase tracking-widest text-muted">{label}</span>
      <span className="truncate text-right" title={value}>{value}</span>
    </div>
  );
}
