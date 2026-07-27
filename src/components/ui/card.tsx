import type { ComponentProps } from "solid-js";
import { cn } from "~/lib/utils";

export function Card(props: ComponentProps<"section">) {
  return (
    <section
      {...props}
      class={cn(
        "rounded-none border border-[var(--border)] bg-[var(--paper)]",
        props.class,
      )}
    />
  );
}
