import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Search, Network as NetworkIcon, Mailbox } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="w-full">
      {/* Hero Section */}
      <section className="py-24 px-6 md:py-32 max-w-7xl mx-auto flex flex-col md:flex-row gap-12 items-center">
        <div className="flex-1 space-y-8">
          <h1 className="text-6xl md:text-8xl tracking-tight leading-[0.9]">
            Your network is your net worth. <span className="italic text-subtle">Manage it like it.</span>
          </h1>
          <p className="font-mono text-subtle max-w-xl text-lg">
            Cirqle is an AI-enhanced personal CRM designed specifically for professionals. 
            Intelligent contact parsing, AI-generated outreach, network visualization, and natural language search.
          </p>
          <div className="flex items-center gap-4 pt-4">
            <Link to="/signup" className="bg-ink text-paper hover:bg-ink/90 px-8 py-3 font-mono transition-colors flex items-center gap-2">
              Get Started Free <ArrowRight size={16} />
            </Link>
          </div>
        </div>
        <div className="flex-[0.8] w-full relative">
          <div className="aspect-[4/3] bg-white border border-ink shadow-[8px_8px_0px_0px_rgba(15,15,15,1)] p-6 flex flex-col">
            <div className="border-b border-ink/20 pb-4 mb-4 flex justify-between items-center">
              <span className="font-serif italic">Contact Parsed</span>
              <span className="font-mono text-xs">JUST NOW</span>
            </div>
            <div className="space-y-4 font-mono text-sm">
              <div className="grid grid-cols-3 border-b border-ink/10 pb-2">
                <span className="text-subtle">Name</span>
                <span className="col-span-2 font-semibold">Sarah Jenkins</span>
              </div>
              <div className="grid grid-cols-3 border-b border-ink/10 pb-2">
                <span className="text-subtle">Company</span>
                <span className="col-span-2">Goldman Sachs</span>
              </div>
              <div className="grid grid-cols-3 border-b border-ink/10 pb-2">
                <span className="text-subtle">Tags</span>
                <span className="col-span-2 flex gap-2">
                  <span className="bg-ink/5 px-2 py-0.5">IBD</span>
                  <span className="bg-ink/5 px-2 py-0.5">MD</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats / Features Bar */}
      <section className="border-y border-ink bg-white">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-ink">
          <div className="p-8 flex-1">
            <h3 className="font-mono text-3xl font-bold mb-2">0 SEC</h3>
            <p className="text-subtle font-mono text-sm">AI contact parsing from any text</p>
          </div>
          <div className="p-8 flex-1">
            <h3 className="font-mono text-3xl font-bold mb-2">100%</h3>
            <p className="text-subtle font-mono text-sm">Natural language search accuracy</p>
          </div>
          <div className="p-8 flex-1">
            <h3 className="font-mono text-3xl font-bold mb-2">ZERO</h3>
            <p className="text-subtle font-mono text-sm">Friction to draft intelligent outreach</p>
          </div>
        </div>
      </section>
    </div>
  );
}
