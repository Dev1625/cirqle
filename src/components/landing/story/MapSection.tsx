import React from 'react';
import { Link } from 'react-router-dom';
import { useTransform } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { StorySection, StoryHeading, StoryReveal, StoryAnchor, useScrub } from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { LandingGraph, GRAPH_ANCHORS } from '../LandingGraph';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 04 — the map.

   This beat's version of "the token arrives at the anchor" is the literal
   one. The graph starts with **no node for the story contact at all** — he
   does not exist in it yet. As the section scrolls, the token travels down
   the You → Venture branch, the same route the graph's own ambient signal
   pulses take, and becomes his node at the end of the run.

   That is why this beat registers three anchors rather than one: the centre
   node, the Venture hub, and the point where the contact will be. The token
   visits them in order across the beat's window, so it reads as a signal
   moving through the network rather than an icon sliding over a picture of
   one. His node, its link and its callout all fade up together as the token
   lands on the third anchor.

   The anchors are positioned as percentages of the graph container because
   the SVG scales fluidly — a percentage marker tracks the node it stands for
   at every width, which fixed offsets would not.
   ──────────────────────────────────────────────────────────────────────── */

const primaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card bg-brand text-brand-on px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] transition-[transform,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';

export function MapSection() {
  const { reduced } = useStoryScroll();
  const scrub = useScrub(3);

  /* Beat 04's sequence, and the one place this page works differently.
     The token lands on "You", dissolves into an outline there, and then
     nothing flies anywhere — the *edge itself* carries a pulse of oxblood
     out to where the contact will be, and his node fades up as that pulse
     arrives. Everything is scrubbed, so scrolling back retracts the colour
     down the branch and takes the node with it. */
  const youOutline = useTransform(scrub, [0.08, 0.2], [0, 1]);
  /* The travelling colour gets over half the beat to itself. It is the one
     thing this section exists to show, and at a third of the window it was
     over almost before it registered. */
  const branch = useTransform(scrub, [0.24, 0.78], [0, 1]);
  const arrival = useTransform(scrub, [0.72, 0.84], [0, 1]);

  return (
    <StorySection index={3} id="network" className="bg-white/40">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <StoryHeading
            index={3}
            title="And now they're on the map."
            body={
              <>
                You sit at the center. Industry lanes fan out around you, each holding the
                people inside it — sized and shaded by how warm the relationship is.
                {' '}{STORY_CONTACT.firstName} arrives down the {STORY_CONTACT.industry} lane,
                one hop out, exactly where you'd look for him.
              </>
            }
          >
            <StoryReveal delay={0.1}>
              <Link to="/signup" className={`${primaryCta} mt-9`}>
                Map your circle <ArrowRight size={15} />
              </Link>
            </StoryReveal>
          </StoryHeading>
        </div>
        <div className="lg:col-span-7 lg:-mr-10 xl:-mr-16">
          <StoryReveal y={24}>
            <div className="relative">
              {/* Two anchors, not three. The token arrives on "You" and
                  re-forms at the contact's node to depart — but it is
                  invisible in between (see StoryToken's visibility rhythm),
                  because the whole point of this beat is that the branch
                  lights up rather than something travelling along it. */}
              <StoryAnchor stage={3} order={0} weight={1.6} style={GRAPH_ANCHORS.me} />
              <StoryAnchor stage={3} order={1} weight={1.6} silent style={GRAPH_ANCHORS.story} />

              <LandingGraph
                arrival={reduced ? undefined : arrival}
                branch={reduced ? undefined : branch}
                youOutline={reduced ? undefined : youOutline}
              />
            </div>
          </StoryReveal>
        </div>
      </div>
    </StorySection>
  );
}
