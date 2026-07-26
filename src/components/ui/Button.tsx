import * as React from "react"
import { cn } from "../../lib/utils"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "brand" | "outline" | "ghost" | "link" | "danger"
  size?: "default" | "sm" | "lg" | "icon"
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {

    return (
      <button
        ref={ref}
        className={cn(
          // NOTE: disabled:opacity-50 deliberately lives on the *variants*, not
          // here. Halving the opacity of the oxblood fill composites to a pale
          // dusty rose over paper — which is how the app's one accent surface
          // ended up reading as washed-out rather than restrained. The brand
          // variant keeps its fill at full strength and signals "busy" by
          // softening only its label.
          // `disabled:pointer-events-none` was removed: it silently cancelled
          // the `disabled:cursor-not-allowed` sitting right next to it, so a
          // disabled button gave no cursor feedback at all. The `disabled`
          // attribute already blocks clicks natively — pointer-events-none
          // bought nothing and cost the only pointer affordance there was.
          "inline-flex items-center justify-center whitespace-nowrap rounded-card font-mono text-[10px] uppercase font-bold tracking-widest transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed",
          {
            "bg-ink text-paper hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50": variant === "default",
            // The single decision-point accent — reserve for true primary CTAs.
            // Disabled keeps the fill at full strength on purpose (halving it
            // composites to a pale dusty rose over paper), but the label drops
            // to /45 and hover/active are suppressed. At /70 the disabled state
            // was near-indistinguishable from the live one: the card page's
            // Continue button looked entirely clickable while inert.
            "bg-brand text-brand-on hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] disabled:bg-brand disabled:text-brand-on/45 disabled:hover:bg-brand disabled:active:scale-100": variant === "brand",
            "border border-ink/15 bg-transparent hover:bg-ink hover:text-paper active:scale-[0.98] disabled:opacity-50": variant === "outline",
            "hover:bg-ink/10 disabled:opacity-50": variant === "ghost",
            "underline-offset-4 hover:underline hover:text-brand disabled:opacity-50": variant === "link",
            "bg-red-600 text-white hover:bg-red-700 active:scale-[0.98] disabled:opacity-50": variant === "danger",
            "h-9 px-4 py-2": size === "default",
            "h-8 px-3 text-[9px]": size === "sm",
            "h-10 px-8": size === "lg",
            "h-9 w-9": size === "icon",
          },
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
