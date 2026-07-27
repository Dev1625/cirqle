import React, { useMemo, useRef } from 'react';
import { motion, useInView, useReducedMotion, type MotionValue } from 'motion/react';
import { STORY_CONTACT, STORY_INITIALS } from './storyContact';

// Echoes the real NetworkGraph industry palette so the landing showcase and
// the in-app graph read as the same system.
const HUBS = [
  { key: 'Banking', color: '#56606A', initials: 'IB' },
  { key: 'Consulting', color: '#746B60', initials: 'CO' },
  { key: 'Venture', color: '#9A7447', initials: 'VC' },
  { key: 'Tech', color: '#6A6473', initials: 'TC' },
  { key: 'Healthcare', color: '#617672', initials: 'HC' },
  { key: 'Equity', color: '#66715F', initials: 'PE' },
];

const W = 760;
const H = 560;
const CX = W / 2;
const CY = H / 2;

type Node = {
  id: string;
  x: number;
  y: number;
  r: number;
  color: string;
  ring?: string;
  label?: string;
  kind: 'me' | 'hub' | 'contact' | 'story';
};
type Link = { id: string; x1: number; y1: number; x2: number; y2: number; strong?: boolean };

function build() {
  const nodes: Node[] = [];
  const links: Link[] = [];

  nodes.push({ id: 'me', x: CX, y: CY, r: 26, color: '#1A1A1A', ring: '#7A2331', kind: 'me', label: 'You' });

  const hubRadius = 188;
  HUBS.forEach((hub, i) => {
    const angle = (i / HUBS.length) * Math.PI * 2 - Math.PI / 2;
    const hx = CX + Math.cos(angle) * hubRadius;
    const hy = CY + Math.sin(angle) * hubRadius * 0.82;
    const hubId = `hub-${hub.key}`;
    nodes.push({ id: hubId, x: hx, y: hy, r: 17, color: hub.color, kind: 'hub', label: hub.initials });
    links.push({ id: `l-me-${hubId}`, x1: CX, y1: CY, x2: hx, y2: hy, strong: true });

    const count = 2 + (i % 2);
    for (let c = 0; c < count; c += 1) {
      const spread = 0.9;
      const ca = angle + (c - (count - 1) / 2) * spread * 0.5;
      const cr = 62 + (c % 2) * 14;
      const x = hx + Math.cos(ca) * cr;
      const y = hy + Math.sin(ca) * cr;
      const cid = `${hubId}-c${c}`;
      nodes.push({ id: cid, x, y, r: 6.5, color: '#E9E4DB', ring: hub.color, kind: 'contact' });
      links.push({ id: `l-${hubId}-${cid}`, x1: hx, y1: hy, x2: x, y2: y });
    }
  });

  // The story contact joins the Venture lane as a real node, not an overlay.
  // Placed deliberately rather than by the generic fan-out above: it needs
  // clear space to its right for the callout, and it needs to be the node
  // your eye lands on first when the section arrives.
  const venture = nodes.find((n) => n.id === 'hub-Venture')!;
  // Pulled in from the hub rather than fanned out like the generic contacts:
  // the callout that follows needs ~120 units of clear space to its right,
  // and the viewBox is only 760 wide.
  const sx = venture.x + 46;
  const sy = venture.y + 34;
  nodes.push({
    id: 'story',
    x: sx,
    y: sy,
    r: 11,
    color: '#7A2331',
    ring: '#7A2331',
    kind: 'story',
    label: STORY_INITIALS,
  });
  links.push({ id: 'l-venture-story', x1: venture.x, y1: venture.y, x2: sx, y2: sy, strong: true });

  return { nodes, links, story: { x: sx, y: sy }, venture: { x: venture.x, y: venture.y } };
}

/**
 * Built once at module scope so the geometry can be published as well as
 * rendered. MapSection needs these three points to place the narrative
 * token's landing markers *inside* the graph — the token flies down the
 * You → Venture → contact branch, so it has to know where that branch is.
 *
 * Published as percentages of the viewBox because the SVG scales fluidly:
 * a marker positioned at a percentage of the container tracks the node it
 * represents at every width, which absolute units would not.
 */
const GRAPH = build();

export const GRAPH_ANCHORS = {
  me: { left: `${(CX / W) * 100}%`, top: `${(CY / H) * 100}%` },
  hub: { left: `${(GRAPH.venture.x / W) * 100}%`, top: `${(GRAPH.venture.y / H) * 100}%` },
  story: { left: `${(GRAPH.story.x / W) * 100}%`, top: `${(GRAPH.story.y / H) * 100}%` },
} as const;

/**
 * `arrival` is the story contact's existence in this graph, 0 → 1.
 *
 * The graph deliberately starts with no node for him at all: he has not
 * arrived yet. The narrative token flies down the You → Venture branch as
 * the section scrolls and *becomes* the node, so his node, its connecting
 * link and its callout all fade up together as the token lands. Without a
 * value passed the node is simply always present.
 */
export function LandingGraph({ arrival }: { arrival?: MotionValue<number> }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-20% 0px' });
  const reduce = useReducedMotion();
  const { nodes, links, story } = useMemo(build, []);

  const show = inView || reduce;
  const storyOpacity = arrival ?? 1;
  const isStoryPart = (id: string) => id === 'story' || id === 'l-venture-story';

  return (
    <div ref={ref} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`An illustration of a personal network: you at the center, connected to industry clusters, each holding individual contacts. ${STORY_CONTACT.name} is highlighted in the ${STORY_CONTACT.industry} cluster.`}
      >
        {/* faint grid to match the in-app graph surface */}
        <defs>
          <pattern id="lg-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="rgba(26,26,26,0.06)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#lg-grid)" />

        {/* links draw in first */}
        {links.map((link, i) =>
          isStoryPart(link.id) ? (
            // Not drawn in with the rest: this link only exists once the
            // contact does, so it is tied to the token's arrival instead.
            <motion.line
              key={link.id}
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke="rgba(122,35,49,0.45)"
              strokeWidth={1.6}
              style={{ opacity: storyOpacity }}
            />
          ) : (
            <motion.line
              key={link.id}
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke={link.strong ? 'rgba(26,26,26,0.28)' : 'rgba(26,26,26,0.14)'}
              strokeWidth={link.strong ? 1.6 : 1}
              initial={reduce ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
              animate={show ? { pathLength: 1, opacity: 1 } : {}}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.03, ease: [0.22, 1, 0.36, 1] }}
            />
          )
        )}

        {/* Ambient signal pulses — a dot travels out from "You" along one hub
            connection at a time, so the constellation reads as a live network
            with traffic on it rather than a static diagram. This graph is
            purely decorative, which is what earns it continuous motion; the
            in-app graph deliberately gets none (see NetworkGraph.tsx).
            Rendered between links and nodes so a pulse passes *under* the
            node it arrives at. */}
        {!reduce &&
          show &&
          links
            .filter((l) => l.strong)
            .map((link, i) => (
              <motion.circle
                key={`pulse-${link.id}`}
                r={3.5}
                fill="#7A2331"
                // cx/cy have to be seeded here as well as animated. Framer
                // only writes an animated attribute once the animation runs,
                // so without these the first paint puts literal "undefined"
                // into cx/cy and SVG rejects it — twelve console errors on
                // every load, one pair per pulse.
                cx={link.x1}
                cy={link.y1}
                initial={{ opacity: 0, cx: link.x1, cy: link.y1 }}
                animate={{
                  cx: [link.x1, link.x2],
                  cy: [link.y1, link.y2],
                  opacity: [0, 0.9, 0.9, 0],
                }}
                transition={{
                  duration: 1.5,
                  // Staggered so the pulses fire in sequence around the ring,
                  // one at a time, instead of all six at once.
                  delay: 1.4 + i * 1.5,
                  repeat: Infinity,
                  repeatDelay: HUBS.length * 1.5 - 1.5,
                  ease: 'easeInOut',
                  opacity: { times: [0, 0.15, 0.8, 1] },
                }}
              />
            ))}

        {/* nodes fade/scale in after their links */}
        {nodes.map((node, i) => {
          const floatDur = 4 + (i % 5) * 0.6;
          return (
            <motion.g
              key={node.id}
              initial={
                isStoryPart(node.id)
                  ? false
                  : reduce
                    ? { opacity: 1, scale: 1 }
                    : { opacity: 0, scale: 0.4 }
              }
              animate={isStoryPart(node.id) ? undefined : show ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.5, delay: 0.5 + i * 0.025, ease: [0.22, 1, 0.36, 1] }}
              style={
                isStoryPart(node.id)
                  ? { transformOrigin: `${node.x}px ${node.y}px`, opacity: storyOpacity }
                  : { transformOrigin: `${node.x}px ${node.y}px` }
              }
            >
              <motion.g
                animate={reduce ? {} : { y: [0, node.kind === 'contact' ? -5 : -3, 0] }}
                transition={reduce ? {} : { duration: floatDur, repeat: Infinity, ease: 'easeInOut', delay: i * 0.15 }}
              >
                {(node.kind === 'me' || node.kind === 'story') && (
                  <motion.circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + 8}
                    fill="none"
                    stroke={node.ring}
                    strokeWidth={1.5}
                    initial={{ opacity: 0.5, scale: 1 }}
                    animate={reduce ? { opacity: 0.35 } : { opacity: [0.5, 0.12, 0.5], scale: [1, 1.18, 1] }}
                    transition={
                      reduce
                        ? {}
                        : {
                            duration: 3.2,
                            repeat: Infinity,
                            ease: 'easeInOut',
                            // Offset from "You" so the two halos breathe out
                            // of phase rather than pulsing in lockstep.
                            delay: node.kind === 'story' ? 1.1 : 0,
                          }
                    }
                    style={{ transformOrigin: `${node.x}px ${node.y}px` }}
                  />
                )}
                <circle cx={node.x} cy={node.y} r={node.r} fill={node.color} />
                {node.ring && node.kind !== 'me' && (
                  <circle cx={node.x} cy={node.y} r={node.r + 2.5} fill="none" stroke={node.ring} strokeWidth={node.kind === 'contact' ? 1.5 : 2} />
                )}
                {node.label && (
                  <text
                    x={node.x}
                    y={node.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontFamily="Inter, sans-serif"
                    fontWeight={node.kind === 'me' ? 700 : 800}
                    fontSize={node.kind === 'me' ? 11 : node.kind === 'story' ? 9 : 10}
                    fill={node.kind === 'me' ? '#F5F0E8' : '#FFFFFF'}
                  >
                    {node.label}
                  </text>
                )}
              </motion.g>
            </motion.g>
          );
        })}

        {/* The callout that makes the story contact findable rather than
            merely present. Tied to the same arrival value as his node — the
            name appears at the moment the token becomes the node, not before,
            so the label is the arrival being announced rather than a caption
            waiting for something to caption. */}
        <motion.g style={{ opacity: storyOpacity }}>
          <line
            x1={story.x + 14}
            y1={story.y}
            x2={story.x + 30}
            y2={story.y}
            stroke="#7A2331"
            strokeWidth={1}
            opacity={0.5}
          />
          <text
            x={story.x + 36}
            y={story.y - 5}
            fontFamily="Playfair Display, Georgia, serif"
            fontWeight={700}
            fontSize={15}
            fill="#1A1A1A"
          >
            {STORY_CONTACT.name}
          </text>
          <text
            x={story.x + 36}
            y={story.y + 10}
            fontFamily="Inconsolata, monospace"
            fontSize={9.5}
            letterSpacing="1.4"
            fill="#5C5850"
          >
            {STORY_CONTACT.company.toUpperCase()} · {STORY_CONTACT.industry.toUpperCase()}
          </text>
        </motion.g>
      </svg>
    </div>
  );
}
