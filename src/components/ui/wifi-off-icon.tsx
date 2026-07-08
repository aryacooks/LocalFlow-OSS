import { forwardRef, useImperativeHandle, useCallback, useEffect } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

interface WifiOffIconProps extends AnimatedIconProps {
  /** Continuously loop the animation instead of only animating on hover. */
  loop?: boolean;
}

const WifiOffIcon = forwardRef<AnimatedIconHandle, WifiOffIconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "", loop = true },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      animate(".wifi-waves", { opacity: [1, 0.4, 1] }, { duration: 0.5, ease: "easeInOut" });
      await animate(".slash-line", { pathLength: [0, 1] }, { duration: 0.45, ease: "easeInOut" });
    }, [animate]);

    const stop = useCallback(() => {
      animate(".slash-line", { pathLength: 1 }, { duration: 0.2 });
      animate(".wifi-waves", { opacity: 1 }, { duration: 0.2 });
    }, [animate]);

    useImperativeHandle(ref, () => ({ startAnimation: start, stopAnimation: stop }));

    useEffect(() => {
      if (!loop) return;
      let active = true;
      const run = async () => {
        while (active) {
          await animate(".slash-line", { pathLength: 0 }, { duration: 0.001 });
          if (!active) break;
          animate(".wifi-waves", { opacity: [1, 0.4, 1] }, { duration: 0.5, ease: "easeInOut" });
          await animate(".slash-line", { pathLength: [0, 1] }, { duration: 0.45, ease: "easeInOut" });
          if (!active) break;
          await new Promise((r) => setTimeout(r, 1000));
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
        onHoverStart={loop ? undefined : start}
        onHoverEnd={loop ? undefined : stop}
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
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <motion.g className="wifi-waves">
          <path d="M12 18l.01 0" />
          <path d="M9.172 15.172a4 4 0 0 1 5.656 0" />
          <path d="M6.343 12.343a7.963 7.963 0 0 1 3.864 -2.14m4.163 .155a7.965 7.965 0 0 1 3.287 2" />
          <path d="M3.515 9.515a12 12 0 0 1 3.544 -2.455m3.101 -.92a12 12 0 0 1 10.325 3.374" />
        </motion.g>
        <motion.path
          className="slash-line"
          d="M3 3l18 18"
          style={{ transformOrigin: "center" }}
          initial={{ pathLength: 0 }}
        />
      </motion.svg>
    );
  },
);

WifiOffIcon.displayName = "WifiOffIcon";
export default WifiOffIcon;
