import React, { useMemo } from 'react';
import { Link } from 'react-router';
import {
  ArrowUpRight,
  ContactRound,
  Link2,
  Network,
  QrCode,
  Radio,
  ShieldCheck,
  SmartphoneNfc,
  Users,
} from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import {
  buildEventAudienceMap,
  type DeterministicEventRecap,
  type EventCaptureChannel,
  type EventConsentState,
  type OrganizerEventMap,
} from '../../lib/eventModeCore';

const CHANNEL_ICON: Record<
  EventCaptureChannel,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  nfc: SmartphoneNfc,
  qr: QrCode,
  'shared-link': Link2,
  'public-card': ContactRound,
  unknown: ContactRound,
};

const CONSENT_LABEL: Record<EventConsentState, string> = {
  'follow-up-consented': 'Follow-up allowed',
  'consented-no-channel': 'Consent, no channel',
  'no-follow-up-consent': 'No outreach consent',
};

function shortDate(value: Date | null): string | null {
  if (!value) return null;
  return value.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function OrganizerEventNetworkMap({
  map,
}: {
  map: OrganizerEventMap;
}) {
  const nodes = map.nodes.slice(0, 13);
  const center = nodes[0];
  const attendees = nodes.slice(1);
  const positions = new Map<string, { x: number; y: number }>();
  if (center) positions.set(center.id, { x: 300, y: 160 });
  attendees.forEach((node, index) => {
    const angle = (index / Math.max(attendees.length, 1)) * Math.PI * 2 -
      Math.PI / 2;
    positions.set(node.id, {
      x: 300 + Math.cos(angle) * 125,
      y: 160 + Math.sin(angle) * 112,
    });
  });

  if (!center || attendees.length === 0) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-card border border-ink/10 bg-paper/50">
      <svg
        viewBox="0 0 600 320"
        className="h-auto w-full"
        role="img"
        aria-labelledby={`event-map-title-${map.nodes[0].id}`}
      >
        <title id={`event-map-title-${map.nodes[0].id}`}>
          Private event map connecting {center.label} with{' '}
          {map.totalAttendees} captured attendees
        </title>
        {attendees.map((node) => {
          const position = positions.get(node.id) as { x: number; y: number };
          return (
            <line
              key={`edge-${node.id}`}
              x1={300}
              y1={160}
              x2={position.x}
              y2={position.y}
              stroke="currentColor"
              strokeOpacity={0.2}
              strokeWidth={1.5}
            />
          );
        })}
        {nodes.map((node) => {
          const position = positions.get(node.id) as { x: number; y: number };
          const organizer = node.kind === 'organizer';
          return (
            <g key={node.id} transform={`translate(${position.x} ${position.y})`}>
              <circle
                r={organizer ? 29 : 21}
                fill={organizer ? '#171717' : '#F7F4ED'}
                stroke={organizer ? '#171717' : '#617672'}
                strokeWidth={organizer ? 2 : 1.5}
              />
              <text
                y={organizer ? 3 : 2}
                textAnchor="middle"
                className={organizer ? 'fill-white' : 'fill-ink'}
                fontSize={organizer ? 9 : 8}
                fontFamily="ui-monospace, monospace"
              >
                {(node.label || 'Unknown').slice(0, organizer ? 11 : 9)}
              </text>
              {!organizer && node.company && (
                <text
                  y={33}
                  textAnchor="middle"
                  className="fill-muted"
                  fontSize={7}
                  fontFamily="ui-monospace, monospace"
                >
                  {node.company.slice(0, 18)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {map.nodes.length > nodes.length && (
        <p className="border-t border-ink/10 px-3 py-2 font-mono text-[9px] text-muted">
          Showing 12 of {map.totalAttendees} private attendee nodes. The full
          recap remains listed above.
        </p>
      )}
    </div>
  );
}

export function EventModeRecap({
  recap,
  organizerLabel,
}: {
  recap: DeterministicEventRecap;
  organizerLabel?: string | null;
}) {
  const organizerMap = useMemo(
    () =>
      buildEventAudienceMap(
        recap,
        'organizer',
        organizerLabel || 'You',
      ),
    [organizerLabel, recap],
  );
  const attendeeSafeMap = useMemo(
    () => buildEventAudienceMap(recap, 'attendee'),
    [recap],
  );

  return (
    <section
      aria-labelledby={`event-recap-${recap.eventSessionId}`}
      className="animate-fade-slide-up mt-4 space-y-4 rounded-card border border-ink/15 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
            <Radio size={11} aria-hidden="true" />
            Deterministic event recap
          </span>
          <h3
            id={`event-recap-${recap.eventSessionId}`}
            className="mt-1.5 font-serif text-lg font-bold italic"
          >
            {recap.headline}
          </h3>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
            Session {recap.eventSessionId.slice(0, 8)} ·{' '}
            {recap.session.source === 'calendar'
              ? 'Calendar-started'
              : 'Manually started'}{' '}
            · No model used
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 bg-paper/60 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
          <ShieldCheck size={11} aria-hidden="true" />
          Organizer only
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-card border border-ink/15 bg-ink/15">
        <div className="bg-paper/70 p-3">
          <dt className="font-mono text-[9px] uppercase tracking-widest text-muted">
            Captures
          </dt>
          <dd className="mt-1 font-serif text-2xl font-black">
            {recap.contactCount}
          </dd>
        </div>
        <div className="bg-paper/70 p-3">
          <dt className="font-mono text-[9px] uppercase tracking-widest text-muted">
            Consented
          </dt>
          <dd className="mt-1 font-serif text-2xl font-black">
            {recap.consentedCount}
          </dd>
        </div>
        <div className="bg-paper/70 p-3">
          <dt className="font-mono text-[9px] uppercase tracking-widest text-muted">
            Ready now
          </dt>
          <dd className="mt-1 font-serif text-2xl font-black">
            {recap.suggestedFollowUps}
          </dd>
        </div>
      </dl>

      {recap.contacts.length === 0 ? (
        <EmptyState
          icon={Link2}
          line="Nobody saved the card during this session. The card link still works if you would rather send it."
        />
      ) : (
        <>
          <div className="border-t border-ink/15 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                  Capture provenance
                </h4>
                <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                  Each issued QR, NFC, and shared-link URL carries a channel
                  marker. This shows the marker recorded on each private
                  contact; it is attribution, not verified hardware.
                </p>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted">
                NFC {recap.channelCounts.nfc} · QR {recap.channelCounts.qr} ·
                Other{' '}
                {recap.channelCounts['shared-link'] +
                  recap.channelCounts['public-card'] +
                  recap.channelCounts.unknown}
              </span>
            </div>
            <ul className="mt-3 divide-y divide-ink/10">
              {recap.contacts.map((contact) => {
                const ChannelIcon = CHANNEL_ICON[contact.provenance.channel];
                return (
                  <li
                    key={contact.id}
                    className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/app/directory/${contact.id}`}
                        className="inline-flex min-h-11 items-center gap-2 font-mono text-xs font-bold underline-offset-4 hover:text-brand hover:underline"
                      >
                        <Users
                          size={12}
                          className="shrink-0 text-muted"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {contact.name}
                          {contact.company ? ` — ${contact.company}` : ''}
                        </span>
                        <ArrowUpRight
                          size={11}
                          className="shrink-0 text-muted"
                          aria-hidden="true"
                        />
                      </Link>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-wider text-muted sm:justify-end">
                      <span className="inline-flex items-center gap-1">
                        <ChannelIcon size={11} aria-hidden="true" />
                        {contact.provenance.label}
                      </span>
                      {shortDate(contact.provenance.capturedAt) && (
                        <time
                          dateTime={
                            contact.provenance.capturedAt?.toISOString()
                          }
                        >
                          {shortDate(contact.provenance.capturedAt)}
                        </time>
                      )}
                      <span
                        className={
                          contact.outreachAllowed
                            ? 'font-bold text-ink'
                            : 'text-brand'
                        }
                      >
                        {CONSENT_LABEL[contact.consentState]}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="border-t border-ink/15 pt-4">
            <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
              Consent-first next actions
            </h4>
            <ol className="mt-3 space-y-2">
              {recap.nextActions.map((action, index) => (
                <li
                  key={action.id}
                  className="flex gap-3 rounded-card border border-ink/10 bg-paper/50 p-3"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink/15 font-mono text-[9px] font-bold"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-bold">
                      {action.label}
                    </p>
                    <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                      {action.reason}
                      {action.dueAt
                        ? ` Target ${action.dueAt.toLocaleDateString()}.`
                        : ''}
                    </p>
                    {!action.outreachAllowed && (
                      <span className="mt-1.5 inline-flex rounded-full border border-brand/25 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-brand">
                        Outreach blocked
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="border-t border-ink/15 pt-4">
            <div className="flex items-center gap-2">
              <Network size={13} className="text-brand" aria-hidden="true" />
              <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                Event relationship map
              </h4>
            </div>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-subtle">
              Your private organizer view contains{' '}
              {organizerMap.nodes.length - 1} attendee node
              {organizerMap.nodes.length - 1 === 1 ? '' : 's'} linked to you.
              The attendee-safe view exposes only {attendeeSafeMap.cohorts.length}{' '}
              cohort{attendeeSafeMap.cohorts.length === 1 ? '' : 's'} of at
              least three people and suppresses{' '}
              {attendeeSafeMap.suppressedAttendees} attendee
              {attendeeSafeMap.suppressedAttendees === 1 ? '' : 's'}.
            </p>
            <OrganizerEventNetworkMap map={organizerMap} />
            {attendeeSafeMap.cohorts.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {attendeeSafeMap.cohorts.map((cohort) => (
                  <li
                    key={cohort.label}
                    className="rounded-full border border-ink/15 bg-paper/60 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-muted"
                  >
                    {cohort.label} · {cohort.attendeeCount}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 flex items-start gap-1.5 font-mono text-[9px] leading-relaxed text-muted">
              <ShieldCheck
                size={11}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              {attendeeSafeMap.disclaimer} This map is never published on the
              card.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
