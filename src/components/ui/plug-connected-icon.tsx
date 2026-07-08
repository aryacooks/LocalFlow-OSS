import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

/**
 * Reversed plug animation: the icon rests in the DISCONNECTED (pulled-apart) state,
 * and `startAnimation` snaps the two halves together (connects). `stopAnimation`
 * pulls them back apart. Driven imperatively via the ref so a parent (e.g. the Quit
 * App button) can play it on hover.
 */
const PlugConnectedIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "" },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    // Connect: bring the halves together and fade the prongs back in.
    const start = useCallback(async () => {
      animate(".plug-upper-part", { x: 0, y: 0 }, { duration: 0.35, ease: "easeOut" });
      animate(".plug-lower-part", { x: 0, y: 0 }, { duration: 0.35, ease: "easeOut" });
      animate(".plug-lower-leg", { opacity: 1 }, { duration: 0.35, ease: "easeOut" });
    }, [animate]);

    // Disconnect: pull the halves apart and fade the prongs out (resting state).
    const stop = useCallback(async () => {
      animate(".plug-upper-part", { x: -2, y: 2 }, { duration: 0.3, ease: "easeInOut" });
      animate(".plug-lower-part", { x: 2, y: -2 }, { duration: 0.3, ease: "easeInOut" });
      animate(".plug-lower-leg", { opacity: 0 }, { duration: 0.3, ease: "easeInOut" });
    }, [animate]);

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
    }));

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
      >
        <motion.path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <motion.path
          d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5z"
          className="plug-lower-part"
          initial={{ x: 2, y: -2 }}
        />
        <motion.path
          d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5z"
          className="plug-upper-part"
          initial={{ x: -2, y: 2 }}
        />
        <motion.path
          d="M3 21l2.5 -2.5"
          className="plug-lower-part"
          initial={{ x: 2, y: -2 }}
        />
        <motion.path
          d="M18.5 5.5l2.5 -2.5"
          className="plug-upper-part"
          initial={{ x: -2, y: 2 }}
        />
        <motion.path
          d="M10 11l-2 2"
          className="plug-lower-part plug-lower-leg"
          initial={{ x: 2, y: -2, opacity: 0 }}
        />
        <motion.path
          d="M13 14l-2 2"
          className="plug-lower-part plug-lower-leg"
          initial={{ x: 2, y: -2, opacity: 0 }}
        />
      </motion.svg>
    );
  },
);

PlugConnectedIcon.displayName = "PlugConnectedIcon";
export default PlugConnectedIcon;
