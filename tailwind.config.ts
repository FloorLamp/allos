import type { Config } from "tailwindcss";

const config: Config = {
  // Class-based dark theme (the theme-boot script toggles `.dark` on <html>),
  // but SCOPED OUT of print (issue #794 cluster 7c). Instead of the plain
  // `"class"` (which emits `.dark .util`), every `dark:` utility compiles to
  // `@media not print { .dark .util }` — same selector/specificity on screen, so
  // screen behavior is byte-for-byte identical, but under print media the dark
  // variants simply don't match. A user printing the Emergency Card / passport
  // from dark mode then falls back to the light utilities (dark text on the
  // forced-white page) instead of near-white `dark:text-slate-100` on white.
  // The `.dark &` shape (not `&:where(.dark, .dark *)`) preserves class-mode
  // specificity exactly; only the enclosing media query is added.
  darkMode: ["variant", "@media not print { .dark & }"],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    // lib/ holds class strings too (priority/range/level color helpers).
    "./lib/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      // Extra breakpoint for widescreen monitors (added to the defaults).
      screens: {
        "3xl": "1920px",
      },
      colors: {
        // Vitals — electric lime-green. 600 = #16a34a primary, 500 the vivid accent.
        brand: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
          900: "#14532d",
          950: "#052e16",
        },
        // Vitals dark surfaces — near-black with a faint green cast (de-blued,
        // unlike slate). Used for page/cards/sidebar gradients.
        ink: {
          950: "#070a09",
          900: "#0c100e",
          850: "#0f1412",
          800: "#141a17",
          750: "#1a211d",
          700: "#283029",
        },
      },
    },
  },
  plugins: [],
};

export default config;
