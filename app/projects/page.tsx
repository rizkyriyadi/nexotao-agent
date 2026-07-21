import { AppShell } from "@/components/AppShell";
import { Projects } from "@/components/projects/Projects";

export default function ProjectsPage() {
  return (
    <AppShell active="projects">
      <Projects />
    </AppShell>
  );
}
