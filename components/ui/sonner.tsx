"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !border-line-strong !bg-popover !text-charcoal !shadow-float !text-[13px] !font-sans",
          description: "!text-bark-grey",
          actionButton: "!bg-charcoal !text-warm-bone",
        },
      }}
      {...props}
    />
  );
}
