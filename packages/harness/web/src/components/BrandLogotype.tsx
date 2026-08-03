import type { CSSProperties, JSX, SVGProps } from "react";

/**
 * The Sapiom wordmark — the brand's default lockup for any surface with room
 * for text. It already spells "Sapiom", so never place the S mark beside it;
 * mark + wordmark reads as a third logo that does not exist in the brand
 * system. Ported from the design-system `@sapiom/design-system/brand` export
 * so the app does not redraw the wordmark; the path is identical to
 * `design-system/assets/sapiom-logotype.svg`.
 *
 * Renders in `currentColor`, so the container's `color` themes it (light/dark),
 * and publishes `--brand-logotype-descender`: the distance from the wordmark's
 * typographic baseline to the bottom of its 24-unit box at the rendered height.
 * A replaced element has no baseline of its own — a flex row synthesises one
 * from its bottom edge — so baseline-aligning the wordmark against text lands
 * its DESCENDER on the text baseline. Nudge the element down by this much to
 * sit the wordmark's own baseline on the text's.
 */
const LOGOTYPE_PATH =
  "M32.1834 7.36578L34.4714 5.81493H36.5941C39.3219 5.81493 41.5567 8.05816 41.5567 10.7996V14.9539C41.5567 17.7234 39.3247 19.9385 36.5941 19.9385H34.4714L32.1834 18.3877V24H29.4277V5.81493H32.1834V7.36578ZM23.7454 7.36578V5.81493H26.5012V19.9385H23.7454V18.3877L21.4574 19.9385H19.3347C16.6069 19.9385 14.3722 17.6953 14.3722 14.9539V10.7996C14.3722 8.03001 16.6041 5.81493 19.3347 5.81493H21.4574L23.7454 7.36578ZM50.2802 17.169H54.0945V19.9385H43.7074V17.169H47.5245V8.58449H43.7074V5.81493H50.2802V17.169ZM73.2556 7.36296L75.5436 5.81212H76.9774C78.4645 5.81212 79.7667 6.60584 80.492 7.79359L81.1557 7.36296L83.4466 5.81212H84.8805C87.1516 5.81212 89 7.66975 89 9.94957V19.9385H86.3199V10.0284C86.3199 9.21495 85.6898 8.58168 84.8805 8.58168H84.3008L81.1585 10.7151V19.9357H78.4001V9.79195C78.2909 9.09675 77.7084 8.58449 76.9802 8.58449H76.4005L73.2556 10.718V19.9385H70.4998V5.81212H73.2556V7.36296ZM64.4479 5.73331C66.3944 5.73331 67.9682 7.31511 67.9682 9.27125V16.2571L64.0923 19.8456L64.0783 19.8569H59.5807C57.6372 19.8569 56.0605 18.2751 56.0605 16.319V9.33316L59.9363 5.74457L59.9504 5.73331H64.4479ZM9.23606 5.81493L11.5549 7.38829V10.7405L8.3539 8.5676H3.91231C2.66607 8.61545 2.63808 10.079 3.62665 10.4618L9.69534 12.3926C11.0284 12.8176 11.9385 14.0616 11.9385 15.4662V16.4907C11.9385 17.5968 11.3925 18.6297 10.4795 19.249L9.65053 19.8119H2.28801L0 18.261V14.9088L3.29339 17.1436H7.53336C7.55015 17.1436 9.29767 17.1859 9.36488 16.0741C9.38729 15.5928 9.12683 15.1059 8.62835 14.9005L2.88732 13.0738C1.16781 12.5249 -0.0476086 10.9515 0.210037 9.16429C0.33886 7.88365 1.34424 5.80931 4.19515 5.83183H4.20356L9.23606 5.82056V5.81493ZM32.1834 10.718V15.0383L35.3284 17.1717H36.5969C37.8096 17.1717 38.8009 16.1754 38.8009 14.9567V10.8024C38.8009 9.58367 37.8096 8.5873 36.5969 8.5873H35.3284L32.1834 10.7208V10.718ZM19.3347 8.58449C18.122 8.58449 17.1307 9.58086 17.1307 10.7996V14.9539C17.1307 16.1726 18.122 17.169 19.3347 17.169H20.6033L23.7454 15.0383V10.718L20.6033 8.58449H19.3347ZM58.7881 10.5378V16.1642C58.7881 16.6764 59.1999 17.0902 59.7096 17.0902H63.0421L65.2377 15.058V9.43168C65.2377 8.91942 64.8261 8.50568 64.3164 8.50568H60.9837L58.7881 10.5378ZM50.283 2.76956H47.2501V0H50.283V2.76956Z";

const BOX_W = 89;
const BOX_H = 24;
const BASELINE_Y = 19.9385; // the 'p' descends to 24; the box bottom is not the baseline
const DESCENDER_RATIO = (BOX_H - BASELINE_Y) / BOX_H;

export interface BrandLogotypeProps extends SVGProps<SVGSVGElement> {
  /** Visual height in CSS pixels. Width follows the 89×24 aspect. */
  height?: number;
}

export function BrandLogotype({ height = 16, className, style, ...props }: BrandLogotypeProps): JSX.Element {
  const labelled = Boolean(props["aria-label"]);
  return (
    <svg
      {...props}
      className={["brand-logotype", className].filter(Boolean).join(" ")}
      style={{ "--brand-logotype-descender": `${DESCENDER_RATIO * height}px`, ...style } as CSSProperties}
      width={(BOX_W / BOX_H) * height}
      height={height}
      viewBox={`0 0 ${BOX_W} ${BOX_H}`}
      fill="none"
      focusable="false"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <path d={LOGOTYPE_PATH} fill="currentColor" />
    </svg>
  );
}
