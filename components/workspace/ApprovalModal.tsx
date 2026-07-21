"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { useWorkspace } from "./workspace-context";

const VERB: Record<string, string> = {
  bash: "run a shell command",
  write_file: "write a file",
  edit_file: "edit a file",
};

export function ApprovalModal() {
  const { approval, approve } = useWorkspace();
  const open = !!approval;
  const name = approval?.name ?? "";
  const input = approval?.input ?? {};

  const preview =
    name === "bash" ? input.command : name === "edit_file" ? input.path : `${input.path}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && approve("deny")}>
      <DialogContent showClose={false}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="size-[7px] rounded-full bg-electric-indigo" />
            <span className="label !text-electric-indigo">Approval</span>
          </div>
          <DialogTitle>Let the agent {VERB[name] ?? name}?</DialogTitle>
          <DialogDescription>Runs locally in your project workspace.</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl bg-muted px-3.5 py-3">
          <code className="whitespace-pre-wrap break-words font-mono text-[13px] text-foreground">{preview}</code>
        </div>
        {name === "write_file" && input.content && (
          <pre className="scroll-thin max-h-48 overflow-auto rounded-xl border border-line bg-code-surface p-3 font-mono text-[12px] leading-relaxed text-bark-grey">
            {String(input.content).slice(0, 2000)}
          </pre>
        )}

        <DialogFooter className="mt-1">
          <Button variant="ghost" size="sm" onClick={() => approve("deny")}>Deny</Button>
          <Button size="sm" onClick={() => approve("allow")}>Allow</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
