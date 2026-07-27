import { splitProps, type ComponentProps } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[4px] text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[var(--ink)] text-white hover:bg-black",
        outline:
          "border border-[var(--border)] bg-white text-[var(--ink)] hover:border-[var(--ink)]",
        ghost: "text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--ink)]",
        accent:
          "bg-[var(--accent)] text-[var(--ink)] hover:bg-[var(--accent-hover)]",
      },
      size: {
        default: "h-10 px-5",
        sm: "h-8 px-3 text-xs",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return (
    <button
      class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)}
      {...rest}
    />
  );
}
