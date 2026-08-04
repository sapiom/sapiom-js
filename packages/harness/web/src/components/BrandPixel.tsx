import type { JSX, SVGProps } from "react";

/**
 * Pixel-grid renditions of the Sapiom brand, for TERMINAL surfaces only — a
 * CLI's boot banner is a mascot block (the way Claude Code's is), and the mark
 * reads as pixel art at that size rather than as a logo pasted next to its
 * name. Both render in `currentColor`. Ported from the design-system
 * `@sapiom/design-system/brand` export (rasterised from the same source assets,
 * not new artwork). Everywhere else, use the vector `BrandLogotype`.
 */

// 60×16 grid, the wordmark rasterised — scripts/gen-pixel-logotype.mjs upstream.
const PIXEL_COLS = 60;
const PIXEL_ROWS = 16;
const PIXEL_PATH =
  "M32 0h2v1h-2zM32 1h2v1h-2zM1 4h6v1h-6zM11 4h4v1h-4zM16 4h2v1h-2zM20 4h7v1h-7zM29 4h5v1h-5zM40 4h5v1h-5zM47 4h7v1h-7zM55 4h4v1h-4zM0 5h8v1h-8zM10 5h8v1h-8zM20 5h8v1h-8zM30 5h4v1h-4zM39 5h7v1h-7zM47 5h13v1h-13zM0 6h2v1h-2zM7 6h1v1h-1zM10 6h2v1h-2zM15 6h3v1h-3zM20 6h3v1h-3zM26 6h2v1h-2zM32 6h2v1h-2zM38 6h2v1h-2zM44 6h2v1h-2zM47 6h3v1h-3zM53 6h3v1h-3zM58 6h2v1h-2zM0 7h4v1h-4zM10 7h2v1h-2zM16 7h2v1h-2zM20 7h2v1h-2zM26 7h2v1h-2zM32 7h2v1h-2zM38 7h2v1h-2zM44 7h2v1h-2zM47 7h2v1h-2zM53 7h2v1h-2zM58 7h2v1h-2zM1 8h6v1h-6zM10 8h2v1h-2zM16 8h2v1h-2zM20 8h2v1h-2zM26 8h2v1h-2zM32 8h2v1h-2zM38 8h2v1h-2zM44 8h2v1h-2zM47 8h2v1h-2zM53 8h2v1h-2zM58 8h2v1h-2zM4 9h4v1h-4zM10 9h2v1h-2zM16 9h2v1h-2zM20 9h2v1h-2zM26 9h2v1h-2zM32 9h2v1h-2zM38 9h2v1h-2zM44 9h2v1h-2zM47 9h2v1h-2zM53 9h2v1h-2zM58 9h2v1h-2zM0 10h1v1h-1zM6 10h2v1h-2zM10 10h2v1h-2zM15 10h3v1h-3zM20 10h2v1h-2zM26 10h2v1h-2zM32 10h2v1h-2zM38 10h2v1h-2zM43 10h3v1h-3zM47 10h2v1h-2zM53 10h2v1h-2zM58 10h2v1h-2zM0 11h8v1h-8zM10 11h8v1h-8zM20 11h8v1h-8zM30 11h6v1h-6zM38 11h7v1h-7zM47 11h2v1h-2zM53 11h2v1h-2zM58 11h2v1h-2zM0 12h7v1h-7zM11 12h7v1h-7zM20 12h7v1h-7zM29 12h8v1h-8zM38 12h6v1h-6zM47 12h2v1h-2zM53 12h2v1h-2zM58 12h2v1h-2zM20 13h2v1h-2zM20 14h2v1h-2zM20 15h2v1h-2z";

// 14×16 grid, the S mark at full ink — scripts/gen-pixel-mark.mjs upstream.
const MARK_COLS = 14;
const MARK_ROWS = 16;
const MARK_PATH =
  "M3 0h9v1h-9zM2 1h11v1h-11zM1 2h13v1h-13zM0 3h4v1h-4zM10 3h3v1h-3zM0 4h4v1h-4zM11 4h3v1h-3zM0 5h5v1h-5zM1 6h7v1h-7zM2 7h9v1h-9zM3 8h10v1h-10zM8 9h5v1h-5zM9 10h5v1h-5zM0 11h1v1h-1zM11 11h3v1h-3zM0 12h4v1h-4zM11 12h3v1h-3zM0 13h13v1h-13zM1 14h12v1h-12zM2 15h10v1h-10z";

interface PixelProps extends SVGProps<SVGSVGElement> {
  /** Size of one grid cell in CSS pixels. Keep it WHOLE so cell edges stay crisp. */
  cell?: number;
}

export function BrandLogotypePixel({ cell = 2, className, ...props }: PixelProps): JSX.Element {
  const labelled = Boolean(props["aria-label"]);
  return (
    <svg
      {...props}
      className={["brand-logotype-pixel", className].filter(Boolean).join(" ")}
      width={PIXEL_COLS * cell}
      height={PIXEL_ROWS * cell}
      viewBox={`0 0 ${PIXEL_COLS} ${PIXEL_ROWS}`}
      shapeRendering="crispEdges"
      fill="none"
      focusable="false"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <path d={PIXEL_PATH} fill="currentColor" />
    </svg>
  );
}

export function BrandMarkPixel({ cell = 3, className, ...props }: PixelProps): JSX.Element {
  const labelled = Boolean(props["aria-label"]);
  return (
    <svg
      {...props}
      className={["brand-mark-pixel", className].filter(Boolean).join(" ")}
      width={MARK_COLS * cell}
      height={MARK_ROWS * cell}
      viewBox={`0 0 ${MARK_COLS} ${MARK_ROWS}`}
      shapeRendering="crispEdges"
      fill="none"
      focusable="false"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <path d={MARK_PATH} fill="currentColor" />
    </svg>
  );
}
