import Link from "next/link";
import { Wordmark } from "@/components/ui";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 text-center">
      <Wordmark />
      <p className="label mt-8">404</p>
      <h1 className="mt-1 text-[30px] font-semibold tracking-[-0.02em] text-charcoal">Page not found</h1>
      <p className="mt-1.5 max-w-[360px] text-[14px] text-bark-grey">
        That route doesn't exist. It may have moved, or never did.
      </p>
      <Button asChild className="mt-6" size="sm">
        <Link href="/">Back to overview</Link>
      </Button>
    </div>
  );
}
