import type { ReactNode } from "react";
import { IconRail } from "./IconRail";
import { CommandPalette } from "./CommandPalette";
import { UpdateBanner } from "./UpdateBanner";

/* Floating app shell: soft canvas backdrop + rounded panel + slim icon rail.
   Referenced from the Moneta dashboard layout. */
export function AppShell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div className="h-full w-full bg-canvas p-2.5">
      <div className="flex h-full w-full overflow-hidden rounded-[26px] bg-warm-bone shadow-float">
        <IconRail active={active} />
        <div className="flex min-w-0 flex-1 flex-col">
          <UpdateBanner />
          <div className="flex min-h-0 flex-1">{children}</div>
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}
