import { Fragment } from "react";

/** Render model text where **double asterisks** mark the part to notice. Everything else stays plain text. */
export function Bold({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
