import forms from "@tailwindcss/forms"
import typography from "@tailwindcss/typography"
import type { Config } from "tailwindcss"
import animate from "tailwindcss-animate"

import { generateTheme } from "./generate-theme"

export const defaultTheme = "sunset"

export const unPriceTailwindPreset: Config = {
  content: ["src/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
  // disable hover on mobiles
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      ...generateTheme(defaultTheme),
      container: {
        center: true,
        padding: "2rem",
        screens: {
          sm: "640px", // mobile phones
          md: "768px", // tablets
          lg: "1024px", // desktops
          xl: "1280px", // large screens
          "2xl": "1536px", // extra large screens
          "4xl": "1920px", // extra large screens
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        primary: ["var(--font-primary)"],
        secondary: ["var(--font-secondary)"],
        mono: ["var(--font-mono)"],
      },
      typography: {
        DEFAULT: {
          css: {
            "blockquote p:first-of-type::before": { content: "none" },
            "blockquote p:first-of-type::after": { content: "none" },
          },
        },
      },
      fontSize: {
        "2xl": ["1.5rem", { lineHeight: "2.25rem" }],
        "3xl": ["1.75rem", { lineHeight: "2.25rem" }],
        "4xl": ["2rem", { lineHeight: "2.5rem" }],
        "5xl": ["2.5rem", { lineHeight: "3rem" }],
        "6xl": ["3rem", { lineHeight: "3.5rem" }],
        // Display scale: marketing-size type. Geist is a variable font, so
        // the weights are tuned numbers (bigger and lighter, never heavier).
        "display-1": [
          "clamp(2.75rem, 2rem + 2.5vw, 3.5rem)",
          { lineHeight: "1.04", letterSpacing: "-0.022em", fontWeight: "540" },
        ],
        "display-2": [
          "clamp(2.25rem, 1.75rem + 1.9vw, 3rem)",
          { lineHeight: "1.08", letterSpacing: "-0.02em", fontWeight: "550" },
        ],
        "display-3": [
          "clamp(1.75rem, 1.55rem + 0.9vw, 2.25rem)",
          { lineHeight: "1.12", letterSpacing: "-0.018em", fontWeight: "560" },
        ],
      },
      // Elevation tokens; per-mode values live in globals.css. Dark mode
      // replaces drop shadows with a lit top edge — black-on-black shadows
      // are invisible, a 1px highlight is what "lifted" looks like there.
      boxShadow: {
        ambient: "var(--shadow-ambient)",
        raised: "var(--shadow-raised)",
        keycap: "var(--shadow-keycap)",
        "keycap-press": "var(--shadow-keycap-press)",
      },
      // Motion tokens: one vocabulary for every hover, entrance, and panel.
      transitionDuration: {
        quick: "160ms",
        regular: "260ms",
        deliberate: "400ms",
      },
      transitionTimingFunction: {
        "out-quad": "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        "out-cubic": "cubic-bezier(0.215, 0.61, 0.355, 1)",
        "out-expo": "cubic-bezier(0.19, 1, 0.22, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%": {
            opacity: "0",
            transform: "translateY(10px)",
          },
          "80%": {
            opacity: "0.6",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
        },
        "fade-down": {
          "0%": {
            opacity: "0",
            transform: "translateY(-10px)",
          },
          "80%": {
            opacity: "0.6",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0px)",
          },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        ripple: {
          "0%, 100%": {
            transform: "translate(-50%, -50%) scale(1)",
          },
          "50%": {
            transform: "translate(-50%, -50%) scale(0.9)",
          },
        },
        hide: {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        slideDownAndFade: {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideLeftAndFade: {
          from: { opacity: "0", transform: "translateX(6px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        slideUpAndFade: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideRightAndFade: {
          from: { opacity: "0", transform: "translateX(-6px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        accordionOpen: {
          from: { height: "0px" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        accordionClose: {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: { height: "0px" },
        },
        dialogOverlayShow: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        dialogContentShow: {
          from: {
            opacity: "0",
            transform: "translate(-50%, -45%) scale(0.95)",
          },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "border-beam": {
          "100%": {
            "offset-distance": "100%",
          },
        },
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(calc(-100% - var(--gap)))" },
        },
        "marquee-vertical": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(calc(-100% - var(--gap)))" },
        },
        "line-shadow": {
          "0%": { "background-position": "0 0" },
          "100%": { "background-position": "100% -100%" },
        },
        aurora: {
          from: {
            backgroundPosition: "0% 50%",
          },
          to: {
            backgroundPosition: "100% 50%",
          },
        },
      },
      animation: {
        aurora: "aurora 60s linear infinite",
        "line-shadow": "line-shadow 15s linear infinite",
        marquee: "marquee var(--duration) linear infinite",
        "marquee-vertical": "marquee-vertical var(--duration) linear infinite",
        ripple: "ripple var(--duration,2s) ease calc(var(--i, 0)*.2s) infinite",
        hide: "hide 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        slideDownAndFade: "slideDownAndFade 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        slideLeftAndFade: "slideLeftAndFade 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        slideUpAndFade: "slideUpAndFade 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        slideRightAndFade: "slideRightAndFade 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        // Accordion
        accordionOpen: "accordionOpen 150ms cubic-bezier(0.87, 0, 0.13, 1)",
        accordionClose: "accordionClose 150ms cubic-bezier(0.87, 0, 0.13, 1)",
        // Dialog
        dialogOverlayShow: "dialogOverlayShow 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        dialogContentShow: "dialogContentShow 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        // Custom
        "fade-up": "fade-up 0.5s",
        "fade-down": "fade-down 0.5s",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "border-beam": "border-beam calc(var(--duration)*1s) infinite linear",
      },
    },
  },
  plugins: [animate, typography, forms],
}
