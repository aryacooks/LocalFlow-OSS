import { useEffect, useRef } from "react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./ui/types";

/** Any of the itshover-style animated icons: a forwardRef svg exposing start/stop. */
type AnimatedIconComponent = ForwardRefExoticComponent<
  AnimatedIconProps & RefAttributes<AnimatedIconHandle>
>;

interface LoopingIconProps {
  icon: AnimatedIconComponent;
  /** Loop the icon's motion while true; hold it still when false. */
  active?: boolean;
  /** Milliseconds for each half (play, then rest) of the loop cycle. */
  period?: number;
  size?: number | string;
  strokeWidth?: number;
  color?: string;
  className?: string;
}

/**
 * Drives an animated icon on a continuous loop while `active` is true — play the
 * motion, hold, reset, hold, repeat. When `active` flips false the icon settles
 * back to its resting state and stops. Used for the sidebar (loop only the icon of
 * the open page) and the About page (loop while the page is mounted).
 */
export default function LoopingIcon({
  icon: Icon,
  active = true,
  period = 850,
  size,
  strokeWidth,
  color,
  className,
}: LoopingIconProps) {
  const ref = useRef<AnimatedIconHandle>(null);

  useEffect(() => {
    if (!active) {
      ref.current?.stopAnimation();
      return;
    }
    let alive = true;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      while (alive) {
        ref.current?.startAnimation();
        await sleep(period);
        if (!alive) break;
        ref.current?.stopAnimation();
        await sleep(period);
      }
    })();
    return () => {
      alive = false;
      ref.current?.stopAnimation();
    };
  }, [active, period]);

  return (
    <Icon
      ref={ref}
      loop={false}
      size={size}
      strokeWidth={strokeWidth}
      color={color}
      className={className}
    />
  );
}
