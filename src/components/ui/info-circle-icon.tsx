import { forwardRef, useImperativeHandle, useCallback, useEffect } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

interface InfoCircleIconProps extends AnimatedIconProps {
  /** Continuously loop the draw animation instead of only animating on hover. */
  loop?: boolean;
}

const InfoCircleIcon = forwardRef<AnimatedIconHandle, InfoCircleIconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "", loop = true },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      await animate(
        ".info-circle-i",
        { pathLength: [0, 1] },
        { duration: 0.3, ease: "easeOut" },
      );
      await animate(
        ".info-line-i",
        { pathLength: [0, 1] },
        { duration: 0.4, ease: "easeOut" },
      );
    }, [animate]);

    const stop = useCallback(() => {
      animate(
        ".info-circle-i, .info-line-i",
        { pathLength: 1 },
        { duration: 0.2, ease: "easeInOut" },
      );
    }, [animate]);

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
    }));

    // Autoplay loop: erase, redraw the dot then the stem, hold, repeat — forever.
    useEffect(() => {
      if (!loop) return;
      let active = true;
      const run = async () => {
        while (active) {
          await animate(
            ".info-circle-i, .info-line-i",
            { pathLength: 0 },
            { duration: 0.001 },
          );
          if (!active) break;
          await animate(
            ".info-circle-i",
            { pathLength: [0, 1] },
            { duration: 0.3, ease: "easeOut" },
          );
          if (!active) break;
          await animate(
            ".info-line-i",
            { pathLength: [0, 1] },
            { duration: 0.4, ease: "easeOut" },
          );
          if (!active) break;
          await new Promise((r) => setTimeout(r, 900));
        }
      };
      run();
      return () => {
        active = false;
      };
    }, [loop, animate]);

    return (
      <motion.svg
        ref={scope}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        onHoverStart={loop ? undefined : start}
        onHoverEnd={loop ? undefined : stop}
      >
        <motion.path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <motion.path
          d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"
          className="info-circle"
        />
        <motion.path d="M12 9h.01" className="info-circle-i" />
        <motion.path d="M11 12h1v4h1" className="info-line-i" />
      </motion.svg>
    );
  },
);

InfoCircleIcon.displayName = "InfoCircleIcon";
export default InfoCircleIcon;
