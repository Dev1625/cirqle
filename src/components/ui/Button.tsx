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
          "inline-flex items-center justify-center whitespace-nowrap rounded-card font-mono text-[10px] uppercase font-bold tracking-widest transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:pointer-events-none disabled:opacity-50",
          {
            "bg-ink text-paper hover:bg-zinc-800 active:scale-[0.98]": variant === "default",
            // The single decision-point accent — reserve for true primary CTAs.
            "bg-brand text-brand-on hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98]": variant === "brand",
            "border border-ink/15 bg-transparent hover:bg-ink hover:text-paper active:scale-[0.98]": variant === "outline",
            "hover:bg-ink/10": variant === "ghost",
            "underline-offset-4 hover:underline hover:text-brand": variant === "link",
            "bg-red-600 text-white hover:bg-red-700 active:scale-[0.98]": variant === "danger",
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
