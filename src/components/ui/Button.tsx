import * as React from "react"
import { cn } from "../../lib/utils"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "link" | "danger"
  size?: "default" | "sm" | "lg" | "icon"
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
    
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap font-mono text-[10px] uppercase font-bold tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink disabled:pointer-events-none disabled:opacity-50",
          {
            "bg-ink text-paper hover:bg-zinc-800": variant === "default",
            "border border-ink bg-transparent hover:bg-ink hover:text-paper": variant === "outline",
            "hover:bg-ink/10": variant === "ghost",
            "underline-offset-4 hover:underline": variant === "link",
            "bg-red-600 text-white hover:bg-red-700": variant === "danger",
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
