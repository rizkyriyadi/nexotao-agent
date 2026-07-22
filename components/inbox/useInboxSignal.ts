"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  describeInboxItems,
  inboxItemIds,
  newlyArrived,
  unreadIds,
  type InboxSnapshot,
} from "@/lib/inbox-signal";

const SEEN_KEY = "nexotao.inbox.seen";
const POLL_MS = 5_000;

function loadSeen(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: string[]) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* private mode / quota — the badge still works in-memory this session */
  }
}

/* Polls /api/inbox and derives the nav attention signal:
   - `count`  — total items waiting (the persistent attention number)
   - `unread` — items the user has not acknowledged (drives the highlighted badge)
   Newly-arrived items raise a toast so the user learns without opening the inbox.
   Visiting /inbox marks everything currently shown as seen. */
export function useInboxSignal() {
  const pathname = usePathname();
  const onInbox = pathname === "/inbox";
  const [count, setCount] = useState(0);
  const [unread, setUnread] = useState(0);
  const seenRef = useRef<string[]>([]);
  const prevIdsRef = useRef<string[] | null>(null);

  useEffect(() => {
    seenRef.current = loadSeen();
  }, []);

  const apply = useCallback(
    (data: InboxSnapshot) => {
      const ids = inboxItemIds(data);
      setCount(ids.length);

      // Notify only for items that appeared since the last poll and were never
      // seen. Skip the first poll (nothing to compare) and skip while on /inbox.
      if (prevIdsRef.current !== null && !onInbox) {
        const seenSet = new Set(seenRef.current);
        const fresh = newlyArrived(ids, prevIdsRef.current).filter((id) => !seenSet.has(id));
        if (fresh.length) {
          toast(`${fresh.length} new inbox item${fresh.length === 1 ? "" : "s"}`, {
            description: `${describeInboxItems(fresh)} need your attention.`,
            action: { label: "Open inbox", onClick: () => window.location.assign("/inbox") },
          });
        }
      }
      prevIdsRef.current = ids;

      if (onInbox) {
        seenRef.current = ids;
        saveSeen(ids);
        setUnread(0);
      } else {
        // Drop acknowledged ids that have since resolved so the store stays bounded.
        const live = new Set(ids);
        seenRef.current = seenRef.current.filter((id) => live.has(id));
        saveSeen(seenRef.current);
        setUnread(unreadIds(ids, seenRef.current).length);
      }
    },
    [onInbox],
  );

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/inbox", { cache: "no-store" })
        .then((response) => response.json())
        .then((data: InboxSnapshot) => {
          if (alive) apply(data);
        })
        .catch(() => {
          /* transient; next tick retries */
        });
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [apply]);

  return { count, unread, hasUnread: unread > 0 };
}
