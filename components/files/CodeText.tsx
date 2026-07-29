"use client";

/* Coloured source. One `<span>` per token, classes only — the palette lives in
   `globals.css` as CSS variables so light and dark are one declaration each
   rather than a branch in every component that shows code. */

import { useMemo } from "react";
import { highlight, type TokenKind } from "@/lib/highlight";

const CLASS: Record<TokenKind, string> = {
  comment: "text-tok-comment italic",
  string: "text-tok-string",
  keyword: "text-tok-keyword",
  type: "text-tok-type",
  constant: "text-tok-constant",
  number: "text-tok-number",
  function: "text-tok-function",
  punct: "text-tok-punct",
  plain: "",
};

export function CodeText({ text, language }: { text: string; language: string }) {
  const tokens = useMemo(() => highlight(text, language), [text, language]);
  return (
    <>
      {tokens.map((token, i) =>
        token.kind === "plain"
          ? token.text
          : <span key={i} className={CLASS[token.kind]}>{token.text}</span>,
      )}
    </>
  );
}
