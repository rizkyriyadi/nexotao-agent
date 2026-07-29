import { AppShell } from "@/components/AppShell";
import { FilesView } from "@/components/files/FilesView";

export const dynamic = "force-dynamic";

// The workspace surface: the project folder as it is on disk, plus a working
// copy for every run currently holding one. Files render for reading — markdown,
// PDFs, images, code — rather than being listed by name alone.
export default function FilesPage() {
  return (
    <AppShell active="files">
      <FilesView />
    </AppShell>
  );
}
