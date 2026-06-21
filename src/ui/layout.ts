/**
 * Phase 10A6 — Tiny Yoga/Flexbox-inspired layout solver (pure, no I/O).
 *
 * Solves a single-pass flexbox-like layout tree into absolute screen
 * coordinates.  All values are deterministic integers (floor-division);
 * no external dependencies, no terminal access.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutNode {
  id: string;
  direction?: "row" | "column";
  fixedWidth?: number;
  fixedHeight?: number;
  grow?: number;
  gap?: number;
  padding?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  children?: LayoutNode[];
}

export interface LayoutResult {
  id: string;
  box: Box;
  children?: LayoutResult[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a layout tree.
 * Throws if duplicate ids are found (case-sensitive).
 */
export function validateLayoutTree(node: LayoutNode): void {
  const seen = new Set<string>();
  function walk(n: LayoutNode): void {
    if (seen.has(n.id)) {
      throw new Error(`duplicate id: "${n.id}"`);
    }
    seen.add(n.id);
    if (n.children) {
      for (const child of n.children) {
        walk(child);
      }
    }
  }
  walk(node);
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Solve the full layout tree for a given terminal `size`.
 * Returns a recursive result tree; use `flattenLayout` to get a flat map.
 */
export function solveLayout(
  node: LayoutNode,
  size: { width: number; height: number },
): LayoutResult {
  return solveNode(node, { x: 0, y: 0, w: size.width, h: size.height });
}

/** Recursive workhorse. */
function solveNode(node: LayoutNode, box: Box): LayoutResult {
  const children = node.children;
  if (!children || children.length === 0) {
    return { id: node.id, box: { ...box } };
  }

  const dir = node.direction ?? "column";
  const gap = node.gap ?? 0;
  const p = node.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };

  // Content area — inset by padding, never negative.
  const cX = box.x + p.left;
  const cY = box.y + p.top;
  const cW = Math.max(0, box.w - p.left - p.right);
  const cH = Math.max(0, box.h - p.top - p.bottom);

  if (dir === "column") {
    return solveColumn(node.id, box, children, cX, cY, cW, cH, gap);
  }
  return solveRow(node.id, box, children, cX, cY, cW, cH, gap);
}

function solveColumn(
  id: string,
  box: Box,
  children: LayoutNode[],
  cX: number,
  cY: number,
  cW: number,
  cH: number,
  gap: number,
): LayoutResult {
  // ---- First pass: account for fixed-height children and gaps ----
  let fixedTotal = 0;
  for (const child of children) {
    if (child.fixedHeight != null) {
      fixedTotal += child.fixedHeight;
    }
  }

  const numGaps = children.length > 1 ? children.length - 1 : 0;
  const gapTotal = numGaps * gap;

  // Space left for grow children (clamped to zero so nothing goes negative).
  let remaining = Math.max(0, cH - fixedTotal - gapTotal);

  // ---- Second pass: calculate grow total ----
  let growTotal = 0;
  for (const child of children) {
    if (child.fixedHeight == null) {
      growTotal += child.grow ?? 0;
    }
  }

  // ---- Distribute ----
  const childResults: LayoutResult[] = [];
  let y = cY;
  let growAllocated = 0;
  let growSeen = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    let childH: number;
    if (child.fixedHeight != null) {
      childH = child.fixedHeight;
    } else if (growTotal > 0) {
      growSeen++;
      const isLastGrow = growSeen === children.filter((c) => c.fixedHeight == null).length;
      if (isLastGrow) {
        // Last grow child gets the remainder so widths sum exactly.
        childH = Math.max(0, remaining - growAllocated);
      } else {
        childH = Math.floor(remaining * (child.grow ?? 0) / growTotal);
        growAllocated += childH;
      }
    } else {
      childH = 0;
    }

    const childBox: Box = { x: cX, y, w: cW, h: childH };
    childResults.push(solveNode(child, childBox));
    y += childH + gap;
  }

  return { id, box: { ...box }, children: childResults };
}

function solveRow(
  id: string,
  box: Box,
  children: LayoutNode[],
  cX: number,
  cY: number,
  cW: number,
  cH: number,
  gap: number,
): LayoutResult {
  // ---- First pass: account for fixed-width children and gaps ----
  let fixedTotal = 0;
  for (const child of children) {
    if (child.fixedWidth != null) {
      fixedTotal += child.fixedWidth;
    }
  }

  const numGaps = children.length > 1 ? children.length - 1 : 0;
  const gapTotal = numGaps * gap;

  // Space left for grow children (clamped to zero).
  let remaining = Math.max(0, cW - fixedTotal - gapTotal);

  // ---- Second pass: calculate grow total ----
  let growTotal = 0;
  for (const child of children) {
    if (child.fixedWidth == null) {
      growTotal += child.grow ?? 0;
    }
  }

  // ---- Distribute ----
  const childResults: LayoutResult[] = [];
  let x = cX;
  let growAllocated = 0;
  let growSeen = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    let childW: number;
    if (child.fixedWidth != null) {
      childW = child.fixedWidth;
    } else if (growTotal > 0) {
      growSeen++;
      const isLastGrow = growSeen === children.filter((c) => c.fixedWidth == null).length;
      if (isLastGrow) {
        childW = Math.max(0, remaining - growAllocated);
      } else {
        childW = Math.floor(remaining * (child.grow ?? 0) / growTotal);
        growAllocated += childW;
      }
    } else {
      childW = 0;
    }

    const childBox: Box = { x, y: cY, w: childW, h: cH };
    childResults.push(solveNode(child, childBox));
    x += childW + gap;
  }

  return { id, box: { ...box }, children: childResults };
}

// ---------------------------------------------------------------------------
// Flatten
// ---------------------------------------------------------------------------

/**
 * Flatten a recursive `LayoutResult` into a flat id→Box map.
 * If the tree was validated beforehand there should be no duplicate ids;
 * later entries silently overwrite earlier ones.
 */
export function flattenLayout(result: LayoutResult): Map<string, Box> {
  const map = new Map<string, Box>();
  function walk(r: LayoutResult): void {
    map.set(r.id, { ...r.box });
    if (r.children) {
      for (const child of r.children) {
        walk(child);
      }
    }
  }
  walk(result);
  return map;
}
