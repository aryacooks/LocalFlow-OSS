import { forwardRef, useImperativeHandle, useCallback, useEffect } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

interface BrandWindowsIconProps extends AnimatedIconProps {
  /** Continuously loop the animation instead of only animating on hover. */
  loop?: boolean;
}

const BrandWindowsIcon = forwardRef<AnimatedIconHandle, BrandWindowsIconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 1, className = "", loop = true },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      const explode = (sel: string, x: number, y: number, rot: number) =>
        animate(
          sel,
          { x: [0, x, x * 0.75], y: [0, y, y * 0.75], rotate: [0, rot, rot * 0.66], scale: [1, 1.1, 1.05] },
          { duration: 0.4, ease: [0.34, 1.56, 0.64, 1] },
        );

      explode("path:nth-of-type(2)", 8, -8, 15);
      explode("path:nth-of-type(3)", -8, 8, -15);
      explode("path:nth-of-type(4)", -8, -8, -15);
      await explode("path:nth-of-type(5)", 8, 8, 15);

      await animate(
        scope.current,
        { rotateY: [0, 180, 360], scale: [1, 1.15, 1] },
        { duration: 0.6, ease: "easeInOut" },
      );

      const snap = (sel: string) =>
        animate(sel, { x: 0, y: 0, rotate: 0, scale: 1 }, { duration: 0.5, ease: [0.34, 1.56, 0.64, 1] });
      snap("path:nth-of-type(2)");
      snap("path:nth-of-type(3)");
      snap("path:nth-of-type(4)");
      await snap("path:nth-of-type(5)");

      await animate(scope.current, { scale: [1, 1.08, 1] }, { duration: 0.3, ease: "easeOut" });
    }, [animate, scope]);

    const stop = useCallback(() => {
      animate(scope.current, { rotateY: 0, scale: 1 }, { duration: 0.4, ease: "easeOut" });
      animate("path:nth-of-type(2)", { x: 0, y: 0, rotate: 0, scale: 1 }, { duration: 0.4 });
      animate("path:nth-of-type(3)", { x: 0, y: 0, rotate: 0, scale: 1 }, { duration: 0.4 });
      animate("path:nth-of-type(4)", { x: 0, y: 0, rotate: 0, scale: 1 }, { duration: 0.4 });
      animate("path:nth-of-type(5)", { x: 0, y: 0, rotate: 0, scale: 1 }, { duration: 0.4 });
    }, [animate, scope]);

    useImperativeHandle(ref, () => ({ startAnimation: start, stopAnimation: stop }));

    useEffect(() => {
      if (!loop) return;
      let active = true;
      const run = async () => {
        while (active) {
          await start();
          if (!active) break;
          await new Promise((r) => setTimeout(r, 1600));
        }
      };
      run();
      return () => {
        active = false;
      };
    }, [loop, start]);

    return (
      <motion.svg
        ref={scope}
        onHoverStart={loop ? undefined : start}
        onHoverEnd={loop ? undefined : stop}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={color}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={{ perspective: "1000px", transformStyle: "preserve-3d" }}
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <motion.path d="M21 13v5c0 1.57 -1.248 2.832 -2.715 2.923l-.113 .003l-.042 .018a1 1 0 0 1 -.336 .056l-.118 -.008l-4.676 -.585v-7.407z" />
        <motion.path d="M11 13v7.157l-5.3 -.662c-1.514 -.151 -2.7 -1.383 -2.7 -2.895v-3.6z" />
        <motion.path d="M11 3.842v7.158h-8v-3.6c0 -1.454 1.096 -2.648 2.505 -2.87z" />
        <motion.path d="M21 5.9v5.1h-8v-7.409l4.717 -.589c1.759 -.145 3.283 1.189 3.283 2.898" />
      </motion.svg>
    );
  },
);

BrandWindowsIcon.displayName = "BrandWindowsIcon";
export default BrandWindowsIcon;
