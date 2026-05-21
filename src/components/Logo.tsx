import React from 'react';

export function Logo() {
  return (
    <div className="group mb-12 flex w-fit cursor-pointer items-center gap-3">
      <div className="relative h-9 w-9 flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-[2px] border-ink bg-paper transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:rotate-90 group-hover:border-ink/0" />
        <div className="absolute right-[-3px] top-1/2 h-3.5 w-4 -translate-y-1/2 bg-paper transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:top-[calc(100%+3px)] group-hover:right-1/2 group-hover:h-4 group-hover:w-4 group-hover:translate-x-1/2 group-hover:-translate-y-full group-hover:rounded-full" />
        <div className="absolute inset-0 rounded-full border-[2px] border-dashed border-ink/0 opacity-0 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:rotate-[270deg] group-hover:border-ink group-hover:opacity-100" />
        <div className="absolute right-[3px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-ink transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:right-1/2 group-hover:translate-x-1/2 group-hover:scale-[1.35]" />
      </div>

      <div className="leading-none">
        <div className="font-serif text-[31px] font-black italic tracking-tight">
          Cirqle
        </div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-subtle">
          CRM
        </div>
      </div>
    </div>
  );
}
