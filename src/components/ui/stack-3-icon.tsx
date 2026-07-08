import { forwardRef, useImperativeHandle, useCallback, useEffect } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

interface Stack3IconProps extends AnimatedIconProps {
  /** Continuously loop the animation instead of only animating on hover. */
  loop?: boolean;
}

const Stack3Icon = forwardRef<AnimatedIconHandle, Stack3IconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "", loop = true },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(() => {
      animate(".layer-1", { y: -3, scale: 1.05 }, { duration: 0.3, ease: "easeOut" });
      animate(".layer-2", { y: -1, opacity: 0.8 }, { duration: 0.3, delay: 0.05, ease: "easeOut" });
      animate(".layer-3", { y: 1, opacity: 0.6 }, { duration: 0.3, delay: 0.1, ease: "easeOut" });
    }, [animate]);

    const stop = useCallback(() => {
      animate(".layer-1", { y: 0, scale: 1 }, { duration: 0.25 });
      animate(".layer-2", { y: 0, opacity: 1 }, { duration: 0.25 });
      animate(".layer-3", { y: 0, opacity: 1 }, { duration: 0.25 });
    }, [animate]);

    useImperativeHandle(ref, () => ({ startAnimation: start, stopAnimation: stop }));

    useEffect(() => {
      if (!loop) return;
      let active = true;
      const run = async () => {
        while (active) {
          start();
          await new Promise((r) => setTimeout(r, 500));
          if (!active) break;
          stop();
          await new Promise((r) => setTimeout(r, 1100));
        }
      };
      run();
      return () => {
        active = false;
      };
    }, [loop, start, stop]);

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
        style={{ overflow: "visible" }}
      >
        <motion.path className="layer-1" d="M12 2l-8 4l8 4l8 -4l-8 -4" />
        <motion.path className="layer-2" d="M4 10l8 4l8 -4" />
        <motion.path className="layer-2" d="M4 14l8 4l8 -4" />
        <motion.path className="layer-3" d="M4 18l8 4l8 -4" />
      </motion.svg>
    );
  },
);

Stack3Icon.displayName = "Stack3Icon";
export default Stack3Icon;
