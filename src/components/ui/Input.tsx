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
          "flex h-11 w-full rounded-card border border-ink/20 bg-transparent px-3 py-2 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 aria-invalid:border-red-600 aria-invalid:ring-1 aria-invalid:ring-red-600/30 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
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
