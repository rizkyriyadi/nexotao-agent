import { WorkspaceProvider } from "./workspace-context";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Chat } from "./Chat";
import { ContextPanel } from "./ContextPanel";
import { ApprovalModal } from "./ApprovalModal";

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <div className="flex h-full w-full overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <Chat />
            <ContextPanel />
          </div>
        </main>
        <ApprovalModal />
      </div>
    </WorkspaceProvider>
  );
}
