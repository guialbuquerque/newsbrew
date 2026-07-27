import type { ComponentProps } from "solid-js";
import { cn } from "~/lib/utils";

export function Badge(props: ComponentProps<"span">) {
  return (
    <span
      {...props}
      class={cn(
        "inline-flex items-center rounded-[3px] border border-[var(--border)] bg-[var(--paper)] px-2.5 py-1 text-[11px] font-semibold tracking-wide text-[var(--muted)]",
        props.class,
      )}
    />
  );
}
