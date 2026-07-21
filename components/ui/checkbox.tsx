"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-[15px] shrink-0 cursor-pointer rounded-[5px] border border-line-strong shadow-xs outline-none transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 data-[state=checked]:border-charcoal data-[state=checked]:bg-charcoal data-[state=checked]:text-warm-bone",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check className="size-3" strokeWidth={3.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
