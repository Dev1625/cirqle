import * as React from "react"
import { cn } from "../../lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // placeholder:text-muted, not text-subtle. --color-subtle (#414141)
          // sits so close to the ink used for real input text (#1A1A1A) that a
          // placeholder reads as an already-filled value — on the card page's
          // name prompt, "Alex Rivera" looked typed in. DESIGN.md assigns
          // placeholders to --color-muted; this follows it.
          "flex h-9 w-full rounded-card border border-ink/15 bg-transparent px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted focus-visible:outline-none focus-visible:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
