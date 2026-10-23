// Rehype plugin that wraps each claim's quote in <mark data-claim-id> inside rendered markdown.
// Quotes can span inline formatting (e.g. part bold), so matching runs over the concatenated
// text of the whole document and the overlapping text nodes are split.

import type { Element, ElementContent, Root, Text } from "hast";
import { normalize, normalizeWithMap } from "./text";

export interface HighlightTarget {
  id: string;
  quote: string;
  status: string;
}

type TextRef = { node: Text; parent: Element | Root; start: number };

export function rehypeClaims(options: { claims: HighlightTarget[] }) {
  return (tree: Root) => {
    const refs: TextRef[] = [];
    let full = "";
    const walk = (node: Element | Root) => {
      for (const child of node.children) {
        if (child.type === "text") {
          refs.push({ node: child, parent: node, start: full.length });
          full += child.value;
        } else if (child.type === "element") {
          if (child.tagName === "pre") continue; // never highlight inside code blocks
          walk(child);
          // Keep block boundaries from gluing words together.
          if (/^(p|li|h[1-6]|td|th|blockquote|div)$/.test(child.tagName)) full += "\n";
        }
      }
    };
    walk(tree);

    // Find a non-overlapping range for each claim, in the full concatenated text.
    const { norm, map } = normalizeWithMap(full);
    const taken: [number, number, HighlightTarget][] = [];
    for (const claim of options.claims) {
      const q = normalize(claim.quote);
      if (!q) continue;
      let idx = norm.indexOf(q);
      while (idx >= 0) {
        const range: [number, number] = [map[idx], map[idx + q.length - 1] + 1];
        if (!taken.some(([s, e]) => range[0] < e && s < range[1])) {
          taken.push([...range, claim]);
          break;
        }
        idx = norm.indexOf(q, idx + 1);
      }
    }
    if (!taken.length) return;

    // Split every text node that overlaps a range into plain and marked pieces.
    for (const ref of refs) {
      const nodeStart = ref.start;
      const nodeEnd = ref.start + ref.node.value.length;
      const hits = taken
        .filter(([s, e]) => s < nodeEnd && nodeStart < e)
        .sort((a, b) => a[0] - b[0]);
      if (!hits.length) continue;

      const pieces: ElementContent[] = [];
      let cursor = nodeStart;
      for (const [s, e, claim] of hits) {
        const from = Math.max(s, nodeStart);
        const to = Math.min(e, nodeEnd);
        if (from > cursor) pieces.push({ type: "text", value: full.slice(cursor, from) });
        pieces.push({
          type: "element",
          tagName: "mark",
          properties: {
            dataClaimId: claim.id,
            className: ["claim", `claim--${claim.status}`],
          },
          children: [{ type: "text", value: full.slice(from, to) }],
        });
        cursor = to;
      }
      if (cursor < nodeEnd) pieces.push({ type: "text", value: full.slice(cursor, nodeEnd) });

      const siblings = ref.parent.children as ElementContent[];
      siblings.splice(siblings.indexOf(ref.node), 1, ...pieces);
    }
  };
}
