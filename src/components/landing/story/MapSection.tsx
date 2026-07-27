import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { StorySection, StoryHeading, StoryReveal } from './StorySection';
import { LandingGraph } from '../LandingGraph';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 04 — the map.

   The contact from beats 1–3 is now a node you can find: same oxblood, same
   ring, sitting in the Venture lane with a callout on it. That is the whole
   argument of this beat — the person you tapped four sections ago has a
   place in the shape of your network now.
   ──────────────────────────────────────────────────────────────────────── */

const primaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card bg-brand text-brand-on px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] transition-[transform,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';

export function MapSection() {
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
                {' '}{STORY_CONTACT.firstName} is in the {STORY_CONTACT.industry} lane, one hop
                out, exactly where you'd look for him.
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
            <LandingGraph />
          </StoryReveal>
        </div>
      </div>
    </StorySection>
  );
}
