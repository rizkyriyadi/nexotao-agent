import Link from "next/link";
import type { ReactNode } from "react";
import { Button as ShadButton } from "./ui/button";
import { IconScissors } from "./icons";

/* Thin wrapper over the shadcn Button so existing call sites (href / variant
   "primary"|"ghost" / size "sm"|"md") keep working. */
export function Button({
  children,
  href,
  onClick,
  variant = "primary",
  size = "md",
  className = "",
  title,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  const v = variant === "primary" ? "default" : "ghost";
  const s = size === "md" ? "default" : "sm";
  if (href)
    return (
      <ShadButton asChild variant={v} size={s} className={className}>
        <Link href={href} title={title}>
          {children}
        </Link>
      </ShadButton>
    );
  return (
    <ShadButton variant={v} size={s} className={className} onClick={onClick} title={title}>
      {children}
    </ShadButton>
  );
}

export function Wordmark() {
  return (
    <div className="inline-flex items-center gap-2 text-charcoal">
      <IconScissors className="size-5" strokeWidth={1.7} />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">Nexotao</span>
    </div>
  );
}

export function Dot({ tone = "muted", pulse = false }: { tone?: string; pulse?: boolean }) {
  const map: Record<string, string> = {
    indigo: "bg-electric-indigo",
    green: "bg-lichen-green",
    muted: "bg-pebble",
    grey: "bg-pebble",
    terracotta: "bg-alarm-red",
  };
  return (
    <span className={`inline-block size-[6px] rounded-full ${map[tone] ?? map.muted} ${pulse ? "nx-pulse" : ""}`} />
  );
}
