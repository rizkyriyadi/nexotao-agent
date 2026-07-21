// Extract readable text from uploaded/opened files on the user's machine, so
// documents like PDFs work even though Nexotao has no native vision — we hand
// the model the extracted text, not the binary.
import { extractText, getDocumentProxy } from "unpdf";

const CTRL = new RegExp("[\\x00-\\x08\\x0E-\\x1F]", "g");

export async function extractFileText(name: string, bytes: Uint8Array): Promise<{ ok: boolean; kind: string; text: string }> {
  const lower = name.toLowerCase();

  if (lower.endsWith(".pdf")) {
    try {
      const pdf = await getDocumentProxy(bytes);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      const body = Array.isArray(text) ? text.join("\n\n") : text;
      if (!body.trim()) return { ok: false, kind: "pdf", text: `${name}: no extractable text (looks like a scanned/image PDF — that needs OCR/vision).` };
      return { ok: true, kind: "pdf", text: `[PDF ${name} — ${totalPages} page(s)]\n\n${body}` };
    } catch (e: any) {
      return { ok: false, kind: "pdf", text: `Could not read ${name}: ${String(e?.message ?? e)}` };
    }
  }

  // everything else: best-effort UTF-8 text
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const ctrl = (text.slice(0, 2000).match(CTRL) || []).length;
    if (ctrl > 40) return { ok: false, kind: "binary", text: `${name} is a binary file with no extractable text.` };
    return { ok: true, kind: "text", text };
  } catch {
    return { ok: false, kind: "binary", text: `${name} is a binary file with no extractable text.` };
  }
}
