import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { Nfc, Sparkles, Search, Network, Activity, Mail } from 'lucide-react';
import { useStoryScroll } from './StoryScroll';

/* ────────────────────────────────────────────────────────────────────────
   The narrative token.

   One object travels the whole page, and it is the same object in every
   beat — that is what makes six sections read as one story rather than six
   features. What it does NOT do is morph: an NFC ripple path-interpolated
   into a graph node is the kind of thing that looks clever in a spec and
   cheap on screen, and the brief explicitly allows skipping it.

   So continuity is carried by *position, scale and colour* — which track
   smoothly and continuously across every handoff — while the stage-specific
   representation inside the token crossfades. The eye follows the ring; the
   ring's contents change under it. The ring itself is the Cirqle mark, so
   the recurring motif and the brand mark are the same shape.

   Everything here animates transform and opacity only. The travel is
   translateY, the emphasis is scale, the handoff is opacity, and the thread
   fill is scaleY against a fixed-height line — never a height animation.
   ──────────────────────────────────────────────────────────────────────── */

export const STORY_STAGES = [
  { key: 'tap', index: '01', label: 'Tap', icon: Nfc },
  { key: 'parse', index: '02', label: 'Parsed', icon: Sparkles },
  { key: 'ask', index: '03', label: 'Asked', icon: Search },
  { key: 'map', index: '04', label: 'Mapped', icon: Network },
  // "Queued", not "Warm": Warm is a tier name in the app's own taxonomy
  // (Strong / Warm / Cold / Dormant) and this beat's card reads Strong.
  { key: 'health', index: '05', label: 'Queued', icon: Activity },
  { key: 'draft', index: '06', label: 'Drafted', icon: Mail },
] as const;

const EVEN_SPACING = STORY_STAGES.map((_, i) => (i + 0.5) / STORY_STAGES.length);

/** Forces a strictly increasing input range, which `useTransform` requires. */
function increasing(values: number[]) {
  return values.reduce<number[]>((acc, v, i) => {
    acc.push(i === 0 ? v : Math.max(v, acc[i - 1] + 1e-4));
    return acc;
  }, []);
}

/**
 * Crossfade window for one stage: fully present at its own stop, gone by the
 * midpoint to either neighbour. The first and last stages hold at full
 * opacity out to the ends of the page so the token is never blank.
 */
function crossfade(stops: number[], i: number): { input: number[]; output: number[] } {
  const last = stops.length - 1;
  const from = i === 0 ? 0 : (stops[i - 1] + stops[i]) / 2;
  const to = i === last ? 1 : (stops[i] + stops[i + 1]) / 2;
  return {
    input: increasing([from, stops[i], to]),
    output: [i === 0 ? 1 : 0, 1, i === last ? 1 : 0],
  };
}

export function StoryRail() {
  const { progress, stops, reduced } = useStoryScroll();

  // Fall back to even spacing until the sections have been measured, so the
  // first frames are never interpolating against an empty range.
  const marks =
    stops.length === STORY_STAGES.length ? increasing([...stops]) : EVEN_SPACING;

  const threadRef = React.useRef<HTMLDivElement>(null);
  const [threadPx, setThreadPx] = React.useState(0);

  React.useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setThreadPx(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* The story ends well before the page does — the roadmap, the closing CTA
     and the footer all sit below beat 06. So the thread is mapped to end at
     the last beat rather than at the bottom of the document: the token
     arrives exactly as the last beat does, and the rail then fades out
     instead of trailing a finished story through unrelated sections. */
  const finish = marks[marks.length - 1];

  /* Travel. Under reduced motion the token does not travel at all — it holds
     at the stage's own position and only its contents change, which is the
     story told as state rather than as movement. */
  const travel = useTransform(progress, [0, finish], [0, threadPx]);
  const steppedTravel = useTransform(progress, (p) => {
    let nearest = 0;
    marks.forEach((m, i) => {
      if (p >= m - 1e-9) nearest = i;
    });
    return ((marks[nearest] ?? 0) / finish) * threadPx;
  });
  const y = reduced ? steppedTravel : travel;

  const railOpacity = useTransform(
    progress,
    increasing([finish, finish + 0.05]),
    [1, 0]
  );

  /* Emphasis. A genuine multi-keyframe range: the token settles to full size
     as it arrives at each beat and eases back down while travelling between
     them, so the six stops are felt rather than merely passed. */
  const scaleInput: number[] = [0];
  const scaleOutput: number[] = [0.88];
  marks.forEach((m, i) => {
    scaleInput.push(m);
    scaleOutput.push(1);
    const next = marks[i + 1];
    if (next !== undefined) {
      scaleInput.push((m + next) / 2);
      scaleOutput.push(0.88);
    }
  });
  scaleInput.push(1);
  scaleOutput.push(0.88);
  const scale = useTransform(progress, increasing(scaleInput), scaleOutput);

  const fill = useTransform(progress, [0, finish], [0, 1]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 left-10 z-30 hidden w-[190px] items-center xl:flex"
      style={{ opacity: railOpacity }}
    >
      <div ref={threadRef} className="relative h-[62vh] w-px">
        {/* The thread. Two stacked hairlines — the brand one is revealed by
            scaling it against the fixed-height track, never by animating
            height. */}
        <div className="absolute inset-0 bg-ink/12" />
        <motion.div
          className="absolute inset-0 origin-top bg-brand"
          style={{ scaleY: reduced ? 1 : fill, opacity: 0.55 }}
        />

        {/* Stage ticks, so the thread reads as a route with stops on it. */}
        {marks.map((m, i) => (
          <span
            key={STORY_STAGES[i].key}
            className="absolute -left-[3px] h-px w-[7px] bg-ink/20"
            style={{ top: `${(m / finish) * 100}%` }}
          />
        ))}

        {/* The token group is anchored on the thread by a static negative
            margin on the ring, not by a percentage translate on the group —
            a -50% x here would shift the whole row (ring + label) left by
            half its combined width and push the label off the viewport. */}
        <motion.div className="absolute left-0 top-0 flex items-center gap-3" style={{ y }}>
          <motion.span
            className="relative -ml-[22px] flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ink/15 bg-paper"
            style={{ scale }}
          >
            {/* The recurring ring — the brand mark, and the one shape that
                never changes across the six beats. */}
            <span className="absolute inset-[3px] rounded-full border border-brand/45" />
            {STORY_STAGES.map((stage, i) => (
              <StageGlyph key={stage.key} stage={stage} progress={progress} range={crossfade(marks, i)} />
            ))}
          </motion.span>

          <span className="relative h-8 w-[128px]">
            {STORY_STAGES.map((stage, i) => (
              <StageLabel key={stage.key} stage={stage} progress={progress} range={crossfade(marks, i)} />
            ))}
          </span>
        </motion.div>
      </div>
    </motion.div>
  );
}

function StageGlyph({
  stage,
  progress,
  range,
}: {
  stage: (typeof STORY_STAGES)[number];
  progress: MotionValue<number>;
  range: { input: number[]; output: number[] };
}) {
  const opacity = useTransform(progress, range.input, range.output);
  const Icon = stage.icon;
  return (
    <motion.span className="absolute inset-0 flex items-center justify-center" style={{ opacity }}>
      <Icon size={16} className="text-brand" />
    </motion.span>
  );
}

function StageLabel({
  stage,
  progress,
  range,
}: {
  stage: (typeof STORY_STAGES)[number];
  progress: MotionValue<number>;
  range: { input: number[]; output: number[] };
}) {
  const opacity = useTransform(progress, range.input, range.output);
  return (
    <motion.span className="absolute inset-0 flex flex-col justify-center" style={{ opacity }}>
      <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-muted">
        {stage.index}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] font-bold text-ink">
        {stage.label}
      </span>
    </motion.span>
  );
}
