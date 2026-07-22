import { AppShell } from "@/components/AppShell";
import { MarketplacePage } from "@/components/marketplace/MarketplacePage";

export const dynamic = "force-dynamic";

// Agent Marketplace: curated hireable role templates and one-click team
// blueprints that spin up a wired team + starter issues.
export default function Marketplace() {
  return (
    <AppShell active="marketplace">
      <MarketplacePage />
    </AppShell>
  );
}
