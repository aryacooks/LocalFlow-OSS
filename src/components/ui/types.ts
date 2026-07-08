import type { SVGProps } from "react";

export type IconEasing =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "circIn"
  | "circOut"
  | "circInOut"
  | "backIn"
  | "backOut"
  | "backInOut"
  | "anticipate";

export interface AnimatedIconProps extends Omit<
  SVGProps<SVGSVGElement>,
  | "ref"
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onDrag"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragExit"
  | "onDragLeave"
  | "onDragOver"
  | "onDragStart"
  | "onDrop"
  | "values"
> {
  /** Icon size in pixels or CSS string */
  size?: number | string;
  /** Icon color (defaults to currentColor) */
  color?: string;
  /** SVG stroke width */
  strokeWidth?: number;
  /** Additional CSS classes */
  className?: string;
  /** Some icons autoplay their own draw loop; set false to hand control to a driver. */
  loop?: boolean;
}

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

/**
 * Scale a stroke width authored against a 24px viewBox up to an icon's own
 * (larger) viewBox, so the rendered line keeps the same visual weight regardless
 * of the design grid the icon was drawn on.
 */
export function scaledStrokeWidth(
  strokeWidth: number,
  viewBoxSize: number,
  baseSize = 24,
): number {
  return (strokeWidth * viewBoxSize) / baseSize;
}
