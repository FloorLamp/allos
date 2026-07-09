import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
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
