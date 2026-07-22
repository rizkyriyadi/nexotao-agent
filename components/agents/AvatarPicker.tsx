"use client";

import { useRef, useState } from "react";
import { Check, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { AGENT_PPS, agentAvatar } from "@/lib/avatars";

/** Downscale an uploaded image to a small square and return a compact data URI,
 *  so the avatar can be stored inline without touching the filesystem. */
async function toAvatarDataUri(file: File, size = 128): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(size / bitmap.width, size / bitmap.height, 1);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/webp", 0.85);
}

/** Avatar selector for the agent editor: pick one of the bundled defaults, or
 *  upload a custom image (downscaled to an inline data URI). */
export function AvatarPicker({ value, index, onChange }: { value: string | null; index: number; onChange: (avatar: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = agentAvatar(value, index);
  const isCustom = Boolean(value && value.startsWith("data:"));

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Please choose an image file");
    setBusy(true);
    try {
      const uri = await toAvatarDataUri(file);
      if (uri.length > 1_400_000) throw new Error("Image is too large after resizing — pick a smaller one");
      onChange(uri);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that image");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-4">
      <img src={current} alt="Selected avatar" className="size-14 shrink-0 rounded-2xl object-cover ring-1 ring-line" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {AGENT_PPS.map((src) => {
            const on = value === src || (!value && agentAvatar(null, index) === src);
            return (
              <button
                key={src}
                type="button"
                onClick={() => onChange(src)}
                className={`relative size-9 overflow-hidden rounded-xl ring-2 transition ${on ? "ring-electric-indigo" : "ring-transparent hover:ring-line-strong"}`}
                aria-label="Use this avatar"
              >
                <img src={src} alt="" className="size-full object-cover" />
                {on && <span className="absolute inset-0 flex items-center justify-center bg-electric-indigo/30"><Check className="size-4 text-white" /></span>}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className={`flex size-9 items-center justify-center rounded-xl ring-2 transition ${isCustom ? "ring-electric-indigo" : "ring-line hover:ring-line-strong"}`}
            aria-label="Upload a custom avatar"
          >
            {busy ? <Loader2 className="size-4 animate-spin text-pebble" /> : <Upload className="size-4 text-bark-grey" />}
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)} className="flex size-9 items-center justify-center rounded-xl text-pebble hover:text-alarm-red" aria-label="Reset avatar">
              <X className="size-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11.5px] text-pebble">Pick a default or upload your own — {isCustom ? "using your uploaded image" : "resized to a small square"}.</p>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
    </div>
  );
}
